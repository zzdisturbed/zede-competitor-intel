const fs = require("node:fs/promises");
const path = require("node:path");
let axios = null;

try {
  // Prefer axios when available, but allow a fetch fallback in offline sandboxes.
  // eslint-disable-next-line global-require
  axios = require("axios");
} catch {
  axios = null;
}

const DATA_DIR = path.join(__dirname, "data");
const ANALYSIS_DIR = path.join(DATA_DIR, "analysis");
const CREATIVES_DIR = path.join(__dirname, "public", "creatives");
const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o";
const WINNER_MIN_DAYS = 30;
const TOP_WINNER_ANALYSIS_LIMIT = 10;
const DOWNLOAD_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

function toSafeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || "n/a";
}

function normalizeAd(ad, payload) {
  const runDays =
    typeof ad.run_days === "number" ? ad.run_days : Number.parseInt(String(ad.run_days ?? ""), 10);

  return {
    ...ad,
    competitor: ad.competitor || payload.competitor || null,
    ad_copy: ad.ad_copy || ad.ad_copy_text || "",
    ad_copy_text: ad.ad_copy_text || ad.ad_copy || "",
    offer_angle: ad.offer_angle || null,
    messaging_theme: ad.messaging_theme || null,
    library_id: String(ad.library_id || "").trim(),
    thumbnail_url: String(ad.thumbnail_url || "").trim(),
    run_days: Number.isFinite(runDays) ? runDays : null
  };
}

function winnerSort(left, right) {
  const rightDays = right.run_days ?? -1;
  const leftDays = left.run_days ?? -1;

  if (rightDays !== leftDays) {
    return rightDays - leftDays;
  }

  return (left.library_id || "").localeCompare(right.library_id || "");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function creativeFilePath(libraryId) {
  return path.join(CREATIVES_DIR, `${libraryId}.jpg`);
}

function analysisFilePath(libraryId) {
  return path.join(ANALYSIS_DIR, `${libraryId}.json`);
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

function normalizeAnalysis(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    visual_hook: toSafeText(source.visual_hook),
    core_message: toSafeText(source.core_message),
    why_it_worked: toSafeText(source.why_it_worked),
    zede_adaptation: toSafeText(source.zede_adaptation)
  };
}

function normalizeAnalysisRecord(record, fallbackLibraryId = null) {
  const source = record && typeof record === "object" ? record : {};
  const analysis =
    source.analysis && typeof source.analysis === "object"
      ? normalizeAnalysis(source.analysis)
      : normalizeAnalysis(source);
  const libraryId = String(source.library_id || fallbackLibraryId || "").trim();

  if (!libraryId) {
    return null;
  }

  return {
    library_id: libraryId,
    analyzed_at: source.analyzed_at || null,
    model: source.model || null,
    competitor: source.competitor || null,
    run_days: source.run_days ?? null,
    offer_angle: source.offer_angle || null,
    messaging_theme: source.messaging_theme || null,
    analysis
  };
}

async function ensureDirectories() {
  await fs.mkdir(CREATIVES_DIR, { recursive: true });
  await fs.mkdir(ANALYSIS_DIR, { recursive: true });
}

async function listDataFiles() {
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(DATA_DIR, entry.name));
}

async function loadAllAds() {
  const dataFiles = await listDataFiles();
  const allAds = [];

  for (const filePath of dataFiles) {
    const raw = await fs.readFile(filePath, "utf8");
    const payload = JSON.parse(raw);
    const ads = Array.isArray(payload.ads) ? payload.ads : [];
    for (const ad of ads) {
      allAds.push(normalizeAd(ad, payload));
    }
  }

  return allAds;
}

function dedupeByLibraryId(ads) {
  const byLibraryId = new Map();

  for (const ad of ads) {
    if (!ad.library_id) {
      continue;
    }

    const previous = byLibraryId.get(ad.library_id);
    if (!previous || winnerSort(ad, previous) < 0) {
      byLibraryId.set(ad.library_id, ad);
    }
  }

  return [...byLibraryId.values()];
}

async function collectWinnerAds() {
  const ads = await loadAllAds();
  const winners = ads.filter(
    (ad) =>
      ad.library_id &&
      typeof ad.run_days === "number" &&
      ad.run_days >= WINNER_MIN_DAYS &&
      Boolean(ad.thumbnail_url)
  );

  return dedupeByLibraryId(winners).sort(winnerSort);
}

async function findAdByLibraryId(libraryId) {
  const normalizedLibraryId = String(libraryId || "").trim();
  if (!normalizedLibraryId) {
    return null;
  }

  const ads = await loadAllAds();
  const candidates = ads
    .filter((ad) => ad.library_id === normalizedLibraryId && Boolean(ad.thumbnail_url))
    .sort(winnerSort);
  return candidates[0] || null;
}

async function downloadCreative(ad) {
  const libraryId = String(ad?.library_id || "").trim();
  const thumbnailUrl = String(ad?.thumbnail_url || "").trim();

  if (!libraryId) {
    throw new Error("Missing library_id while downloading creative.");
  }

  if (!thumbnailUrl) {
    throw new Error(`Missing thumbnail_url for ${libraryId}.`);
  }

  const outputPath = creativeFilePath(libraryId);
  if (await fileExists(outputPath)) {
    return outputPath;
  }

  const headers = {
    "User-Agent": DOWNLOAD_USER_AGENT,
    Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://www.facebook.com/"
  };

  let imageBytes;
  if (axios) {
    const response = await axios.get(thumbnailUrl, {
      responseType: "arraybuffer",
      timeout: 45000,
      maxRedirects: 5,
      headers
    });
    imageBytes = Buffer.from(response.data);
  } else {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(thumbnailUrl, {
        headers,
        redirect: "follow",
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Creative download failed (${response.status})`);
      }
      imageBytes = Buffer.from(await response.arrayBuffer());
    } finally {
      clearTimeout(timeout);
    }
  }

  await fs.writeFile(outputPath, imageBytes);
  return outputPath;
}

async function readAnalysisRecord(libraryId) {
  const filePath = analysisFilePath(libraryId);
  if (!(await fileExists(filePath))) {
    return null;
  }

  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  return normalizeAnalysisRecord(parsed, libraryId);
}

async function saveAnalysisRecord(ad, analysis) {
  const libraryId = String(ad.library_id || "").trim();
  const record = {
    library_id: libraryId,
    analyzed_at: new Date().toISOString(),
    model: OPENAI_MODEL,
    competitor: ad.competitor || null,
    run_days: ad.run_days ?? null,
    offer_angle: ad.offer_angle || null,
    messaging_theme: ad.messaging_theme || null,
    analysis: normalizeAnalysis(analysis)
  };

  const filePath = analysisFilePath(libraryId);
  await fs.writeFile(filePath, JSON.stringify(record, null, 2), "utf8");
  return record;
}

async function analyzeCreative(ad) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing.");
  }

  const creativePath = await downloadCreative(ad);
  const imageBase64 = (await fs.readFile(creativePath)).toString("base64");
  const prompt = `Analyze this competitor ad creative. It ran ${toSafeText(ad.run_days)} days (angle: ${toSafeText(ad.offer_angle)}). Extract as JSON: {"visual_hook","core_message","why_it_worked","zede_adaptation"}.`;
  const context = {
    competitor: ad.competitor || null,
    run_days: ad.run_days ?? null,
    offer_angle: ad.offer_angle || null,
    messaging_theme: ad.messaging_theme || null,
    ad_copy: ad.ad_copy_text || ad.ad_copy || ""
  };

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      store: false,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                `${prompt}\n` +
                "Context: ZEDE Paris is a premium French leather handbag brand. Keep zede_adaptation specific and practical.\n" +
                `Metadata:\n${JSON.stringify(context, null, 2)}`
            },
            {
              type: "input_image",
              image_url: `data:image/jpeg;base64,${imageBase64}`
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "creative_analysis",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              visual_hook: { type: "string" },
              core_message: { type: "string" },
              why_it_worked: { type: "string" },
              zede_adaptation: { type: "string" }
            },
            required: ["visual_hook", "core_message", "why_it_worked", "zede_adaptation"]
          }
        }
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API ${response.status}: ${errorText.slice(0, 500)}`);
  }

  const payload = await response.json();
  const text = extractResponseText(payload);
  if (!text) {
    throw new Error("OpenAI returned no structured analysis.");
  }

  const parsed = JSON.parse(text);
  return normalizeAnalysis(parsed);
}

async function analyzeWinnerAd(ad, options = {}) {
  const libraryId = String(ad?.library_id || "").trim();
  if (!libraryId) {
    throw new Error("Cannot analyze ad without library_id.");
  }

  await ensureDirectories();
  if (!options.force) {
    const existing = await readAnalysisRecord(libraryId);
    if (existing) {
      return existing;
    }
  }

  const analysis = await analyzeCreative(ad);
  return saveAnalysisRecord(ad, analysis);
}

async function analyzeWinnerByLibraryId(libraryId, options = {}) {
  const ad = await findAdByLibraryId(libraryId);
  if (!ad) {
    throw new Error(`Ad ${libraryId} was not found or has no thumbnail.`);
  }
  return analyzeWinnerAd(ad, options);
}

async function loadAnalysisMap() {
  const entries = await fs.readdir(ANALYSIS_DIR, { withFileTypes: true }).catch(() => []);
  const map = new Map();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const filePath = path.join(ANALYSIS_DIR, entry.name);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const fallbackLibraryId = entry.name.replace(/\.json$/i, "");
      const record = normalizeAnalysisRecord(parsed, fallbackLibraryId);
      if (record) {
        map.set(record.library_id, record);
      }
    } catch (error) {
      console.warn(`Skipping invalid analysis file ${entry.name}: ${error.message}`);
    }
  }

  return map;
}

function parseArgs(argv) {
  const args = {
    force: false
  };

  for (const value of argv) {
    if (value === "--force") {
      args.force = true;
    }
  }

  return args;
}

async function runBatchAnalysis(options = {}) {
  await ensureDirectories();
  const winners = await collectWinnerAds();

  if (winners.length === 0) {
    console.log("No winner ads found with run_days >= 30 and a thumbnail.");
    return { winners, analyzed: [] };
  }

  console.log(`Found ${winners.length} winner ads (run_days >= ${WINNER_MIN_DAYS}).`);
  for (const ad of winners) {
    try {
      await downloadCreative(ad);
    } catch (error) {
      console.warn(`Creative download failed for ${ad.library_id}: ${error.message}`);
    }
  }

  const topWinners = winners.slice(0, TOP_WINNER_ANALYSIS_LIMIT);
  const analyzed = [];

  for (const [index, ad] of topWinners.entries()) {
    try {
      console.log(
        `Analyzing ${index + 1}/${topWinners.length}: ${ad.library_id} (${ad.competitor}, ${ad.run_days} days)`
      );
      const record = await analyzeWinnerAd(ad, options);
      analyzed.push(record);
    } catch (error) {
      console.warn(`Analysis failed for ${ad.library_id}: ${error.message}`);
    }
  }

  console.log(`Saved/updated ${analyzed.length} analyses in ${path.relative(__dirname, ANALYSIS_DIR)}.`);
  return { winners, analyzed };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await runBatchAnalysis({ force: args.force });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  ANALYSIS_DIR,
  CREATIVES_DIR,
  WINNER_MIN_DAYS,
  TOP_WINNER_ANALYSIS_LIMIT,
  analyzeWinnerAd,
  analyzeWinnerByLibraryId,
  analysisFilePath,
  collectWinnerAds,
  creativeFilePath,
  downloadCreative,
  ensureDirectories,
  loadAnalysisMap,
  readAnalysisRecord,
  runBatchAnalysis
};
