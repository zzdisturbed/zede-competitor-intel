const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const COMPETITORS = [
  { name: "Cabaïa", pageId: "254811818003716", country: "FR" },
  { name: "Faguo", pageId: "88944535935", country: "FR" },
  { name: "Herschel", pageId: "196619000354059", country: "FR" },
  { name: "Polène", pageId: "1844332612465362", country: "FR" },
  { name: "DeMellier", pageId: "157968695269134", country: "GB" },
  { name: "Portland Leather", pageId: "1236481509710650", country: "US" }
];

const DATA_DIR = path.join(__dirname, "data");
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MIN_ADS = 55;
const MAX_SCROLL_PASSES = 40;
const STAGNANT_SCROLL_LIMIT = 5;
const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const AI_TAGGING_CHUNK_SIZE = 25;
const OFFER_ANGLES = ["discount", "social_proof", "pain_point", "aspirational", "urgency", "authority"];

const MONTHS = {
  jan: 0,
  january: 0,
  janv: 0,
  feb: 1,
  february: 1,
  fev: 1,
  fevr: 1,
  mars: 2,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  avr: 3,
  may: 4,
  mai: 4,
  jun: 5,
  june: 5,
  juin: 5,
  jul: 6,
  july: 6,
  juil: 6,
  aug: 7,
  august: 7,
  aout: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
  decembre: 11
};

function normalizeKey(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "")
    .toLowerCase();
}

function competitorSlug(name) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase();
}

function getParisDateStamp(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris"
  }).format(date);
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function toIsoDate(date) {
  return new Date(Date.UTC(date.year, date.month, date.day))
    .toISOString()
    .slice(0, 10);
}

function parseDateLabel(label) {
  if (!label) {
    return null;
  }

  const cleaned = label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\./g, "")
    .replace(/,/g, "")
    .trim();

  const parts = cleaned.split(/\s+/);
  if (parts.length !== 3) {
    return null;
  }

  const [monthLabel, dayLabel, yearLabel] = parts;
  const month = MONTHS[monthLabel.toLowerCase()];
  const day = Number.parseInt(dayLabel, 10);
  const year = Number.parseInt(yearLabel, 10);

  if (month === undefined || Number.isNaN(day) || Number.isNaN(year)) {
    return null;
  }

  return { year, month, day };
}

function calculateRunDays(startDate, endDate) {
  if (!startDate || !endDate) {
    return null;
  }

  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return null;
  }

  return Math.floor((end - start) / DAY_IN_MS) + 1;
}

function resolveDates(status, dateText, scrapedDate) {
  if (!dateText) {
    return {
      startDate: null,
      endDate: null,
      runDays: null
    };
  }

  if (/^Started running on /i.test(dateText)) {
    const start = parseDateLabel(dateText.replace(/^Started running on /i, ""));
    const startDate = start ? toIsoDate(start) : null;
    const endDate = status === "Active" ? null : scrapedDate;
    return {
      startDate,
      endDate,
      runDays: calculateRunDays(startDate, endDate || scrapedDate)
    };
  }

  const [startLabel, endLabel] = dateText.split(/\s+-\s+/);
  const start = parseDateLabel(startLabel);
  const end = parseDateLabel(endLabel);
  const startDate = start ? toIsoDate(start) : null;
  const endDate = end ? toIsoDate(end) : null;

  return {
    startDate,
    endDate,
    runDays: calculateRunDays(startDate, endDate || scrapedDate)
  };
}

function parseArgs(argv) {
  const args = {
    competitorFilter: [],
    minAds: DEFAULT_MIN_ADS,
    headed: false,
    skipAiTagging: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--competitor" && argv[index + 1]) {
      args.competitorFilter = argv[index + 1]
        .split(",")
        .map((entry) => normalizeKey(entry))
        .filter(Boolean);
      index += 1;
      continue;
    }

    if (value === "--min-ads" && argv[index + 1]) {
      const parsed = Number.parseInt(argv[index + 1], 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        args.minAds = parsed;
      }
      index += 1;
      continue;
    }

    if (value === "--headed") {
      args.headed = true;
    }

    if (value === "--skip-ai-tagging") {
      args.skipAiTagging = true;
    }
  }

  return args;
}

async function randomDelay(page, minMs = 2000, maxMs = 4000) {
  await page.waitForTimeout(randomBetween(minMs, maxMs));
}

function buildMetaAdLibraryUrl({ country, pageId }) {
  const url = new URL("https://www.facebook.com/ads/library/");
  url.searchParams.set("active_status", "all");
  url.searchParams.set("ad_type", "all");
  url.searchParams.set("country", country);
  url.searchParams.set("view_all_page_id", pageId);
  return url.toString();
}

async function waitForLibraryCards(page) {
  await page.waitForFunction(() => {
    const body = document.body ? document.body.innerText : "";
    return body.includes("Library ID:") || body.includes("No ads");
  }, { timeout: 120000 });
}

async function getLoadedAdCount(page) {
  return page.evaluate(() => {
    const ids = new Set();
    for (const span of document.querySelectorAll("span")) {
      const match = (span.innerText || "").match(/Library ID:\s*(\d+)/i);
      if (match) {
        ids.add(match[1]);
      }
    }
    return ids.size;
  });
}

async function scrollToLoadAds(page, minAds) {
  let stagnantPasses = 0;

  for (let pass = 1; pass <= MAX_SCROLL_PASSES; pass += 1) {
    const beforeCount = await getLoadedAdCount(page);
    console.log(`  Scroll pass ${pass}: ${beforeCount} ads loaded`);

    if (beforeCount >= minAds) {
      break;
    }

    await page.evaluate(() => {
      window.scrollBy(0, Math.max(window.innerHeight * 1.6, 1800));
    });
    await randomDelay(page);

    const afterCount = await getLoadedAdCount(page);
    if (afterCount <= beforeCount) {
      stagnantPasses += 1;
    } else {
      stagnantPasses = 0;
    }

    if (stagnantPasses >= STAGNANT_SCROLL_LIMIT) {
      break;
    }
  }
}

async function extractAds(page, competitorName, scrapedAt, scrapedDate) {
  const rawAds = await page.evaluate((name) => {
    const CTA_LINES = new Set([
      "Apply Now",
      "Book Now",
      "Buy Now",
      "Call Now",
      "Contact Us",
      "Download",
      "Get Offer",
      "Get Quote",
      "Learn More",
      "Listen Now",
      "Order Now",
      "Read More",
      "Send Message",
      "Send WhatsApp Message",
      "Shop Now",
      "Sign Up",
      "Watch More"
    ]);

    function normalizeText(value) {
      return value
        .replace(/\u200b/g, "")
        .replace(/\s+\n/g, "\n")
        .replace(/\n{2,}/g, "\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
    }

    function libraryLabelCount(value) {
      return (value.match(/Library ID:/gi) || []).length;
    }

    function isDomainLine(line) {
      return /^[A-Z0-9.-]+\.[A-Z]{2,}(?:\/[A-Z0-9._/-]+)?$/i.test(line) && !/\s/.test(line);
    }

    function isTerminalCopyLine(line) {
      return (
        /^\d+:\d{2}\s*\/\s*\d+:\d{2}$/.test(line) ||
        /^www\./i.test(line) ||
        isDomainLine(line) ||
        CTA_LINES.has(line)
      );
    }

    function looksLikeLandingLine(line, nextLines) {
      if (!line || line.length > 40) {
        return false;
      }

      return nextLines.some((entry) => isTerminalCopyLine(entry));
    }

    function extractCopy(lines, sponsoredIndex) {
      const copyLines = [];

      for (let index = sponsoredIndex + 1; index < lines.length; index += 1) {
        const line = lines[index];
        const nextLines = lines.slice(index + 1, index + 3);

        if (isTerminalCopyLine(line) || (copyLines.length > 0 && looksLikeLandingLine(line, nextLines))) {
          break;
        }

        if (!line || line === name) {
          continue;
        }

        copyLines.push(line);
      }

      return normalizeText(copyLines.join(" "));
    }

    function findCard(node) {
      let current = node.parentElement;
      while (current) {
        const text = normalizeText(current.innerText || "");
        if (text.includes("Sponsored") && text.includes("Library ID:") && libraryLabelCount(text) === 1) {
          return current;
        }
        current = current.parentElement;
      }
      return null;
    }

    const seenIds = new Set();
    const ads = [];

    for (const span of document.querySelectorAll("span")) {
      const idMatch = (span.innerText || "").match(/Library ID:\s*(\d+)/i);
      if (!idMatch) {
        continue;
      }

      const libraryId = idMatch[1];
      if (seenIds.has(libraryId)) {
        continue;
      }

      const card = findCard(span);
      if (!card) {
        continue;
      }

      const text = normalizeText(card.innerText || "");
      const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
      const status = lines.find((line) => /^(Active|Inactive)$/i.test(line)) || "Unknown";
      const dateText =
        lines.find((line) => /^Started running on /i.test(line)) ||
        lines.find((line) => /^[A-Z][a-z]{2,9} \d{1,2}, \d{4} - [A-Z][a-z]{2,9} \d{1,2}, \d{4}$/.test(line)) ||
        "";
      const sponsoredIndex = lines.findIndex((line) => line === "Sponsored");
      const advertiser = sponsoredIndex > 0 ? lines[sponsoredIndex - 1] : name;
      const adCopy = sponsoredIndex >= 0 ? extractCopy(lines, sponsoredIndex) : "";
      const videoCount = card.querySelectorAll("video").length;
      const imageCount = card.querySelectorAll("img").length;

      ads.push({
        library_id: libraryId,
        advertiser,
        status,
        date_text: dateText,
        ad_copy: adCopy,
        ad_copy_text: adCopy,
        format: videoCount > 0 ? "video" : imageCount >= 4 ? "carousel" : "image"
      });

      seenIds.add(libraryId);
    }

    return ads;
  }, competitorName);

  return rawAds.map((ad) => {
    const { startDate, endDate, runDays } = resolveDates(ad.status, ad.date_text, scrapedDate);
    return {
      ...ad,
      competitor: competitorName,
      scraped_at: scrapedAt,
      start_date: startDate,
      end_date: endDate,
      run_days: runDays
    };
  });
}

function normalizeThemeLabel(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value).trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) {
    return null;
  }

  return normalized.split(" ").slice(0, 3).join(" ");
}

function applyTagging(ads, tagMap) {
  return ads.map((ad) => {
    const tag = tagMap.get(ad.library_id);
    return {
      ...ad,
      offer_angle: tag?.offer_angle || null,
      messaging_theme: tag?.messaging_theme || null
    };
  });
}

function extractResponseText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  const parts = [];
  for (const output of payload.output || []) {
    if (output.type !== "message") {
      continue;
    }

    for (const content of output.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }

  return parts.join("").trim();
}

async function classifyAdChunk(chunkAds, competitorName) {
  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      store: false,
      instructions:
        "Classify competitor Meta ads by psychological offer angle and messaging theme. " +
        "Choose exactly one offer_angle from discount, social_proof, pain_point, aspirational, urgency, authority. " +
        "Definitions: discount = savings, offer, promotion; social_proof = reviews, testimonials, popularity, UGC; " +
        "pain_point = problem/friction reduction; aspirational = identity, lifestyle, desire, transformation; " +
        "urgency = limited-time or act-now pressure; authority = expertise, trust, credentials, product quality proof. " +
        "messaging_theme must be a concise 1-3 word lowercase label. Use only the supplied metadata and copy. " +
        "Do not invent product claims not present in the input.",
      input: JSON.stringify(
        {
          competitor: competitorName,
          ads: chunkAds.map((ad) => ({
            library_id: ad.library_id,
            status: ad.status,
            start_date: ad.start_date,
            run_days: ad.run_days,
            ad_copy_text: ad.ad_copy_text || ad.ad_copy
          }))
        },
        null,
        2
      ),
      text: {
        format: {
          type: "json_schema",
          name: "ad_tagging",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              tags: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    library_id: { type: "string" },
                    offer_angle: { type: "string", enum: OFFER_ANGLES },
                    messaging_theme: { type: "string" }
                  },
                  required: ["library_id", "offer_angle", "messaging_theme"]
                }
              }
            },
            required: ["tags"]
          }
        }
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API ${response.status}: ${errorText.slice(0, 400)}`);
  }

  const payload = await response.json();
  const text = extractResponseText(payload);
  if (!text) {
    throw new Error("No structured output returned by OpenAI.");
  }

  const parsed = JSON.parse(text);
  return Array.isArray(parsed.tags) ? parsed.tags : [];
}

async function tagAdsWithAi(ads, competitorName, options) {
  if (options.skipAiTagging) {
    console.log("  AI tagging skipped by flag");
    return applyTagging(ads, new Map());
  }

  if (!OPENAI_API_KEY) {
    console.log("  OPENAI_API_KEY missing, skipping AI tagging");
    return applyTagging(ads, new Map());
  }

  const taggableAds = ads.filter((ad) => (ad.ad_copy_text || ad.ad_copy || "").trim());
  if (taggableAds.length === 0) {
    console.log("  No ad copy available for AI tagging");
    return applyTagging(ads, new Map());
  }

  const tagMap = new Map();
  const batches = chunk(taggableAds, AI_TAGGING_CHUNK_SIZE);

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    console.log(`  AI tagging batch ${index + 1}/${batches.length} (${batch.length} ads)`);

    try {
      const tags = await classifyAdChunk(batch, competitorName);
      for (const tag of tags) {
        const offerAngle = OFFER_ANGLES.includes(tag.offer_angle) ? tag.offer_angle : null;
        const messagingTheme = normalizeThemeLabel(tag.messaging_theme);
        if (!tag.library_id) {
          continue;
        }

        tagMap.set(tag.library_id, {
          offer_angle: offerAngle,
          messaging_theme: messagingTheme
        });
      }
    } catch (error) {
      console.warn(`  AI tagging failed for batch ${index + 1}: ${error.message}`);
    }

    await sleep(250);
  }

  return applyTagging(ads, tagMap);
}

async function scrapeCompetitor(context, competitor, minAds, dateStamp, options) {
  const page = await context.newPage();
  const url = buildMetaAdLibraryUrl(competitor);
  const scrapedAt = new Date().toISOString();
  const scrapedDate = dateStamp;

  console.log(`Scraping ${competitor.name} (${competitor.country})`);
  console.log(`  ${url}`);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await waitForLibraryCards(page);
    await randomDelay(page);
    await scrollToLoadAds(page, minAds);

    const scrapedAds = await extractAds(page, competitor.name, scrapedAt, scrapedDate);
    const ads = await tagAdsWithAi(scrapedAds, competitor.name, options);
    const payload = {
      competitor: competitor.name,
      page_id: competitor.pageId,
      country: competitor.country,
      source_url: url,
      scraped_at: scrapedAt,
      ad_count: ads.length,
      total_ads: ads.length,
      ads
    };

    const outputFile = path.join(DATA_DIR, `${competitorSlug(competitor.name)}-${dateStamp}.json`);
    await fs.writeFile(outputFile, JSON.stringify(payload, null, 2), "utf8");

    console.log(`  Saved ${ads.length} ads to ${path.relative(__dirname, outputFile)}`);
    return payload;
  } finally {
    await page.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const selectedCompetitors =
    args.competitorFilter.length === 0
      ? COMPETITORS
      : COMPETITORS.filter((competitor) => {
          const key = normalizeKey(competitor.name);
          const pageKey = normalizeKey(competitor.pageId);
          return args.competitorFilter.includes(key) || args.competitorFilter.includes(pageKey);
        });

  if (selectedCompetitors.length === 0) {
    throw new Error("No competitors matched the --competitor filter.");
  }

  await fs.mkdir(DATA_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: !args.headed });
  const context = await browser.newContext({
    locale: "en-US",
    colorScheme: "light",
    viewport: { width: 1440, height: 1600 },
    timezoneId: "Europe/Paris",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
  });

  const dateStamp = getParisDateStamp();
  const results = [];

  try {
    for (const competitor of selectedCompetitors) {
      const payload = await scrapeCompetitor(context, competitor, args.minAds, dateStamp, args);
      results.push({
        competitor: payload.competitor,
        ad_count: payload.ad_count,
        scraped_at: payload.scraped_at
      });
      await sleep(randomBetween(2000, 4000));
    }
  } finally {
    await context.close();
    await browser.close();
  }

  console.log("");
  console.log("Scrape summary");
  for (const result of results) {
    console.log(`- ${result.competitor}: ${result.ad_count} ads (${result.scraped_at})`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
