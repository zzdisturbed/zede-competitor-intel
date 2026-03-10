const fs = require("node:fs/promises");
const path = require("node:path");
const express = require("express");

const PORT = Number.parseInt(process.env.PORT || "8795", 10);
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");

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

app.use(express.static(PUBLIC_DIR));

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

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ZEDE competitor dashboard running on http://localhost:${PORT}`);
});
