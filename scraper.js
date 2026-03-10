const fs = require("node:fs/promises");
const path = require("node:path");

// ── Competitors ──────────────────────────────────────────────────────────────
const COMPETITORS = [
  { name: "Cabaïa", pageId: "254811818003716", country: "FR" },
  { name: "Faguo", pageId: "88944535935", country: "FR" },
  { name: "Herschel", pageId: "196619000354059", country: "FR" },
  { name: "Polène", pageId: "1844332612465362", country: "FR" },
  { name: "DeMellier", pageId: "157968695269134", country: "GB" },
  { name: "Portland Leather", pageId: "1236481509710650", country: "US" }
];

// ── Config ───────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN || "";
const APIFY_ACTOR = "curious_coder~facebook-ads-library-scraper";
const APIFY_TIMEOUT = 180; // seconds
const APIFY_COUNT = 60; // max ads per competitor
const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const AI_TAGGING_CHUNK_SIZE = 25;
const OFFER_ANGLES = ["discount", "social_proof", "pain_point", "aspirational", "urgency", "authority"];

// ── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function competitorSlug(name) {
  return name.toUpperCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function normalizeKey(v) {
  return String(v || "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function getParisDateStamp() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
}

function formatDate(ts) {
  if (!ts) return null;
  const d = new Date(ts * 1000);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// ── Apify call ───────────────────────────────────────────────────────────────
async function callApify(competitor) {
  const adLibraryUrl = `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=${competitor.country}&view_all_page_id=${competitor.pageId}`;

  const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${APIFY_API_TOKEN}&timeout=${APIFY_TIMEOUT}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      urls: [{ url: adLibraryUrl }],
      count: APIFY_COUNT
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Apify ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("Apify returned non-array response");
  return data;
}

// ── Transform Apify data → our schema ────────────────────────────────────────
function pickThumbnail(snap) {
  // 1. Video poster
  if (snap.videos?.length) {
    const poster = snap.videos[0].video_preview_image_url;
    if (poster) return poster;
  }
  // 2. Card video poster
  for (const card of snap.cards || []) {
    if (card.video_preview_image_url) return card.video_preview_image_url;
  }
  // 3. Image
  if (snap.images?.length) {
    const url = snap.images[0].resized_image_url;
    if (url) return url;
  }
  // 4. Card image
  for (const card of snap.cards || []) {
    if (card.resized_image_url) return card.resized_image_url;
  }
  return "";
}

function pickVideoUrl(snap) {
  // 1. Main videos
  if (snap.videos?.length) {
    return snap.videos[0].video_hd_url || snap.videos[0].video_sd_url || "";
  }
  // 2. Card videos
  for (const card of snap.cards || []) {
    if (card.video_hd_url) return card.video_hd_url;
    if (card.video_sd_url) return card.video_sd_url;
  }
  return "";
}

function detectFormat(snap) {
  const hasVideo = (snap.videos?.length > 0) ||
    (snap.cards || []).some(c => c.video_hd_url || c.video_sd_url);
  if (hasVideo) return "video";
  if ((snap.cards || []).length >= 2) return "carousel";
  return "image";
}

function transformAd(raw, competitorName, scrapedAt, dateStamp) {
  const snap = raw.snapshot || {};
  const isActive = Boolean(raw.is_active);
  const startTs = raw.start_date || null;
  const nowTs = Math.floor(Date.now() / 1000);

  const startDate = startTs ? new Date(startTs * 1000).toISOString() : null;
  const runDays = startTs ? Math.floor((nowTs - startTs) / 86400) : null;

  const startFmt = startTs ? formatDate(startTs) : "";
  const dateText = isActive
    ? (startFmt ? `Started running on ${startFmt}` : "")
    : (startFmt ? `${startFmt} - ${formatDate(nowTs)}` : "");

  const adCopy = snap.body?.text || "";
  const variantCount = typeof raw.collation_count === "number" ? raw.collation_count : 1;

  return {
    library_id: String(raw.ad_archive_id || ""),
    advertiser: snap.page_name || competitorName,
    status: isActive ? "Active" : "Inactive",
    date_text: dateText,
    ad_copy: adCopy,
    ad_copy_text: adCopy,
    format: detectFormat(snap),
    thumbnail_url: pickThumbnail(snap),
    video_url: pickVideoUrl(snap),
    variant_count: variantCount,
    eu_reach_text: "",
    eu_reach_min: 0,
    competitor: competitorName,
    scraped_at: scrapedAt,
    start_date: startDate,
    end_date: null,
    run_days: runDays,
    offer_angle: null,
    messaging_theme: null
  };
}

// ── AI Tagging (identical logic to original) ─────────────────────────────────
function normalizeThemeLabel(value) {
  if (!value) return null;
  const n = String(value).trim().toLowerCase().replace(/\s+/g, " ");
  return n ? n.split(" ").slice(0, 3).join(" ") : null;
}

function extractResponseText(payload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }
  const parts = [];
  for (const output of payload.output || []) {
    if (output.type !== "message") continue;
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
      input: JSON.stringify({
        competitor: competitorName,
        ads: chunkAds.map((ad) => ({
          library_id: ad.library_id,
          status: ad.status,
          start_date: ad.start_date,
          run_days: ad.run_days,
          ad_copy_text: ad.ad_copy_text || ad.ad_copy
        }))
      }, null, 2),
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
  if (!text) throw new Error("No structured output returned by OpenAI.");
  const parsed = JSON.parse(text);
  return Array.isArray(parsed.tags) ? parsed.tags : [];
}

async function tagAdsWithAi(ads, competitorName) {
  if (!OPENAI_API_KEY) {
    console.log("  OPENAI_API_KEY missing, skipping AI tagging");
    return ads;
  }

  const taggable = ads.filter((ad) => (ad.ad_copy_text || "").trim());
  if (taggable.length === 0) {
    console.log("  No ad copy available for AI tagging");
    return ads;
  }

  const tagMap = new Map();
  const batches = chunk(taggable, AI_TAGGING_CHUNK_SIZE);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`  AI tagging batch ${i + 1}/${batches.length} (${batch.length} ads)`);
    try {
      const tags = await classifyAdChunk(batch, competitorName);
      for (const tag of tags) {
        if (!tag.library_id) continue;
        tagMap.set(tag.library_id, {
          offer_angle: OFFER_ANGLES.includes(tag.offer_angle) ? tag.offer_angle : null,
          messaging_theme: normalizeThemeLabel(tag.messaging_theme)
        });
      }
    } catch (error) {
      console.warn(`  AI tagging failed for batch ${i + 1}: ${error.message}`);
    }
    await sleep(250);
  }

  return ads.map((ad) => {
    const tag = tagMap.get(ad.library_id);
    return {
      ...ad,
      offer_angle: tag?.offer_angle || null,
      messaging_theme: tag?.messaging_theme || null
    };
  });
}

// ── Scrape one competitor ────────────────────────────────────────────────────
async function scrapeCompetitor(competitor, dateStamp) {
  const scrapedAt = new Date().toISOString();
  console.log(`Scraping ${competitor.name} (${competitor.country}) via Apify`);

  const rawAds = await callApify(competitor);

  // Filter out error items
  const validAds = rawAds.filter(a => a.ad_archive_id && !a.error);
  console.log(`  Apify returned ${rawAds.length} items, ${validAds.length} valid ads`);

  // Transform
  let ads = validAds.map(raw => transformAd(raw, competitor.name, scrapedAt, dateStamp));

  // AI tagging
  ads = await tagAdsWithAi(ads, competitor.name);

  // Count formats
  const videoCount = ads.filter(a => a.format === "video").length;
  const withVideoUrl = ads.filter(a => a.video_url).length;
  console.log(`  ${ads.length} ads total | ${videoCount} video format | ${withVideoUrl} with video URL`);

  // Save
  const payload = {
    competitor: competitor.name,
    page_id: competitor.pageId,
    country: competitor.country,
    source: "apify",
    scraped_at: scrapedAt,
    ad_count: ads.length,
    total_ads: ads.length,
    ads
  };

  const outputFile = path.join(DATA_DIR, `${competitorSlug(competitor.name)}-${dateStamp}.json`);
  await fs.writeFile(outputFile, JSON.stringify(payload, null, 2), "utf8");
  console.log(`  Saved ${ads.length} ads to ${path.relative(__dirname, outputFile)}`);

  return { competitor: competitor.name, ad_count: ads.length, scraped_at: scrapedAt };
}

// ── CLI args ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const filters = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--competitor" && argv[i + 1]) {
      filters.push(normalizeKey(argv[i + 1]));
      i++;
    }
  }
  return { competitorFilter: filters };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!APIFY_API_TOKEN) throw new Error("APIFY_API_TOKEN env var is required");

  const args = parseArgs(process.argv.slice(2));
  const selected = args.competitorFilter.length === 0
    ? COMPETITORS
    : COMPETITORS.filter(c => {
        const key = normalizeKey(c.name);
        const pageKey = normalizeKey(c.pageId);
        return args.competitorFilter.includes(key) || args.competitorFilter.includes(pageKey);
      });

  if (selected.length === 0) throw new Error("No competitors matched the --competitor filter.");

  await fs.mkdir(DATA_DIR, { recursive: true });
  const dateStamp = getParisDateStamp();
  const results = [];

  for (const competitor of selected) {
    try {
      const result = await scrapeCompetitor(competitor, dateStamp);
      results.push(result);
    } catch (error) {
      console.error(`  ERROR scraping ${competitor.name}: ${error.message}`);
      results.push({ competitor: competitor.name, ad_count: 0, scraped_at: new Date().toISOString(), error: error.message });
    }
    await sleep(2000); // Be nice between requests
  }

  console.log("");
  console.log("Scrape summary");
  for (const r of results) {
    const suffix = r.error ? ` [ERROR: ${r.error}]` : "";
    console.log(`- ${r.competitor}: ${r.ad_count} ads (${r.scraped_at})${suffix}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
