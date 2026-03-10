const fs = require("node:fs/promises");
const path = require("node:path");
const express = require("express");
const {
  analyzeWinnerByLibraryId,
  collectWinnerAds,
  creativeFilePath,
  ensureDirectories,
  loadAnalysisMap
} = require("./analyzer");

const PORT = Number.parseInt(process.env.PORT || "8795", 10);
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const CREATIVES_DIR = path.join(PUBLIC_DIR, "creatives");

function normalizeKey(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "")
    .toLowerCase();
}

function dominantFormat(ads) {
  const counts = new Map();
  for (const ad of ads) {
    const format = ad.format || "unknown";
    counts.set(format, (counts.get(format) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    })[0]?.[0] || "unknown";
}

function normalizeAd(ad) {
  return {
    ...ad,
    ad_copy: ad.ad_copy || ad.ad_copy_text || "",
    offer_angle: ad.offer_angle || null,
    messaging_theme: ad.messaging_theme || null
  };
}

function toInt(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function computeScore(ad) {
  const runDays = toInt(ad.run_days, 0);
  const variantCount = toInt(ad.variant_count, 1);
  const status = String(ad.status || "").trim().toLowerCase();
  const euReachText = String(ad.eu_reach_text || "").trim();

  const runDaysScore = runDays >= 240 ? 40 : runDays >= 120 ? 30 : runDays >= 60 ? 20 : runDays >= 30 ? 10 : 5;
  const activeBonus = status === "active" ? 25 : 0;
  const variantBonus = variantCount >= 10 ? 20 : variantCount >= 5 ? 15 : variantCount >= 2 ? 8 : 0;
  const euReachBonus = euReachText ? 15 : 0;
  const total = runDaysScore + activeBonus + variantBonus + euReachBonus;
  const score = Math.max(0, Math.min(100, total));

  return {
    score,
    breakdown: {
      run_days_score: runDaysScore,
      active_bonus: activeBonus,
      variant_bonus: variantBonus,
      eu_reach_bonus: euReachBonus
    }
  };
}

function breakdownBy(ads, field) {
  const counts = new Map();

  for (const ad of ads) {
    const value = String(ad[field] || "").trim();
    if (!value) {
      continue;
    }
    counts.set(value, (counts.get(value) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    })
    .map(([label, count]) => ({ label, count }));
}

function recentThemes(ads, limit = 4) {
  const sorted = ads
    .filter((ad) => ad.messaging_theme && ad.start_date)
    .slice()
    .sort((left, right) => String(right.start_date).localeCompare(String(left.start_date)));

  const timeline = [];
  const seen = new Set();

  for (const ad of sorted) {
    const key = String(ad.messaging_theme).toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    timeline.push({
      messaging_theme: ad.messaging_theme,
      offer_angle: ad.offer_angle || null,
      start_date: ad.start_date
    });

    if (timeline.length >= limit) {
      break;
    }
  }

  return timeline;
}

function currentWinner(ads) {
  return ads
    .filter((ad) => String(ad.status || "").toLowerCase() === "active" && typeof ad.run_days === "number")
    .sort((left, right) => {
      if (right.run_days !== left.run_days) {
        return right.run_days - left.run_days;
      }
      return (left.library_id || "").localeCompare(right.library_id || "");
    })[0] || null;
}

async function loadLatestSnapshots() {
  const entries = await fs.readdir(DATA_DIR, { withFileTypes: true }).catch(() => []);
  const jsonFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  const snapshots = [];

  for (const file of jsonFiles) {
    const filePath = path.join(DATA_DIR, file.name);
    const raw = await fs.readFile(filePath, "utf8");
    const payload = JSON.parse(raw);
    snapshots.push({
      filePath,
      payload
    });
  }

  const latestByCompetitor = new Map();
  for (const snapshot of snapshots) {
    const key = normalizeKey(snapshot.payload.competitor || snapshot.filePath);
    const previous = latestByCompetitor.get(key);
    const currentTimestamp = Date.parse(snapshot.payload.scraped_at || 0);
    const previousTimestamp = previous ? Date.parse(previous.payload.scraped_at || 0) : 0;

    if (!previous || currentTimestamp >= previousTimestamp) {
      latestByCompetitor.set(key, snapshot);
    }
  }

  return [...latestByCompetitor.values()]
    .map(({ payload }) => {
      const ads = Array.isArray(payload.ads) ? payload.ads : [];
      const normalizedAds = ads.map(normalizeAd);
      const offerAngleBreakdown = breakdownBy(normalizedAds, "offer_angle");
      const messagingThemeBreakdown = breakdownBy(normalizedAds, "messaging_theme");
      const winners = ads
        .slice()
        .sort((left, right) => {
          const rightDays = right.run_days ?? -1;
          const leftDays = left.run_days ?? -1;
          if (rightDays !== leftDays) {
            return rightDays - leftDays;
          }
          return (left.library_id || "").localeCompare(right.library_id || "");
        })
        .slice(0, 10);

      return {
        competitor: payload.competitor,
        country: payload.country,
        page_id: payload.page_id,
        source_url: payload.source_url,
        scraped_at: payload.scraped_at,
        ad_count: ads.length,
        dominant_format: dominantFormat(normalizedAds),
        top_offer_angle: offerAngleBreakdown[0]?.label || null,
        top_messaging_theme: messagingThemeBreakdown[0]?.label || null,
        offer_angle_breakdown: offerAngleBreakdown,
        messaging_theme_breakdown: messagingThemeBreakdown,
        recent_themes: recentThemes(normalizedAds),
        current_winner: currentWinner(normalizedAds),
        winners: winners.map(normalizeAd)
      };
    })
    .sort((left, right) => left.competitor.localeCompare(right.competitor));
}

const app = express();

app.use(express.json());
app.use("/creatives", express.static(CREATIVES_DIR));
app.use(express.static(PUBLIC_DIR));

async function loadLocalCreativeIds() {
  const entries = await fs.readdir(CREATIVES_DIR, { withFileTypes: true }).catch(() => []);
  const ids = new Set();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jpg")) {
      continue;
    }

    ids.add(entry.name.replace(/\.jpg$/i, ""));
  }

  return ids;
}

async function sendDashboardSummary(_request, response) {
  try {
    const competitors = await loadLatestSnapshots();
    response.json({
      generated_at: new Date().toISOString(),
      competitors: competitors.map((competitor) => ({
        ...competitor,
        last_scraped_at: competitor.scraped_at,
        current_winner: competitor.current_winner ? normalizeAd(competitor.current_winner) : null,
        winners: (competitor.winners || []).map(normalizeAd)
      }))
    });
  } catch (error) {
    response.status(500).json({
      error: "Unable to load summary data",
      details: error.message
    });
  }
}

app.get("/api/summary", sendDashboardSummary);
app.get("/api/dashboard", sendDashboardSummary);

app.get("/api/winners", async (_request, response) => {
  try {
    await ensureDirectories();
    const [winners, analysisMap, localCreativeIds] = await Promise.all([
      collectWinnerAds(),
      loadAnalysisMap(),
      loadLocalCreativeIds()
    ]);

    const scoredWinners = winners
      .map((winner) => {
        const normalized = normalizeAd(winner);
        const analysisRecord = analysisMap.get(normalized.library_id) || null;
        const hasLocalCreative = localCreativeIds.has(normalized.library_id);
        const { score, breakdown } = computeScore(normalized);

        return {
          ...normalized,
          score,
          breakdown,
          creative_url: hasLocalCreative
            ? `/creatives/${encodeURIComponent(normalized.library_id)}.jpg`
            : normalized.thumbnail_url || null,
          analysis: analysisRecord ? analysisRecord.analysis : null,
          analysis_meta: analysisRecord
            ? {
                analyzed_at: analysisRecord.analyzed_at,
                model: analysisRecord.model
              }
            : null
        };
      })
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        const rightDays = right.run_days ?? -1;
        const leftDays = left.run_days ?? -1;
        if (rightDays !== leftDays) {
          return rightDays - leftDays;
        }

        return (left.library_id || "").localeCompare(right.library_id || "");
      });

    response.json({
      generated_at: new Date().toISOString(),
      count: scoredWinners.length,
      winners: scoredWinners
    });
  } catch (error) {
    response.status(500).json({
      error: "Unable to load winner ads",
      details: error.message
    });
  }
});

app.post("/api/analyze/:library_id", async (request, response) => {
  const libraryId = String(request.params.library_id || "").trim();
  if (!libraryId) {
    response.status(400).json({ error: "library_id is required" });
    return;
  }

  try {
    const force = request.query.force === "1" || request.query.force === "true";
    const record = await analyzeWinnerByLibraryId(libraryId, { force });
    const localCreativeExists = await fs
      .access(creativeFilePath(libraryId))
      .then(() => true)
      .catch(() => false);

    response.json({
      ok: true,
      library_id: libraryId,
      creative_url: localCreativeExists ? `/creatives/${encodeURIComponent(libraryId)}.jpg` : null,
      analysis: record.analysis,
      analysis_meta: {
        analyzed_at: record.analyzed_at,
        model: record.model
      }
    });
  } catch (error) {
    const statusCode = /not found/i.test(error.message) ? 404 : 500;
    response.status(statusCode).json({
      error: "Unable to analyze ad creative",
      details: error.message
    });
  }
});

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

ensureDirectories().catch((error) => {
  console.warn(`Failed to ensure analysis directories: ${error.message}`);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ZEDE competitor dashboard running on http://localhost:${PORT}`);
});
