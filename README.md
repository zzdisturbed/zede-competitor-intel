# ZEDE Paris Competitor Ad Intelligence

Node.js app that scrapes Meta Ad Library with Playwright and serves an Express dashboard on port `8795`.

## What it does

- Scrapes Meta Ad Library for:
  - Cabaïa
  - Faguo
  - Herschel
  - Polène
  - DeMellier
  - Portland Leather
- Extracts per ad:
  - `library_id`
  - `status`
  - `start_date`
  - `end_date`
  - `run_days`
  - `ad_copy`
  - `offer_angle`
  - `messaging_theme`
  - `format`
- Saves one JSON snapshot per competitor to `data/COMPETITOR-YYYY-MM-DD.json`
- Serves a dashboard that shows:
  - current active winner per competitor
  - top 10 longest-running ads per competitor
  - active/inactive badges
  - run duration in days
  - ad copy truncated to 100 characters
  - dominant format per competitor
  - offer angle and messaging theme filters
  - angle/theme grouping summaries
  - last scraped timestamp

## Setup

```bash
npm install
npx playwright install chromium
```

Set your OpenAI key before scraping if you want AI tagging enabled:

```bash
export OPENAI_API_KEY=your_key_here
```

Optional:

```bash
export OPENAI_MODEL=gpt-4.1-mini
```

## Run the scraper

```bash
npm run scrape
```

Optional flags:

```bash
node scraper.js --competitor cabaia --min-ads 20
node scraper.js --headed
node scraper.js --skip-ai-tagging
```

## Start the dashboard

```bash
npm start
```

Open `http://localhost:8795`.

## Notes

- Meta Ad Library is dynamic and rate-limited. The scraper uses a real Chromium session plus random `2-4s` delays while scrolling.
- AI tagging is done in batches via the OpenAI Responses API after scraping each competitor.
- The scraper defaults to loading at least `55` ads per competitor, or stops earlier if Meta stops returning additional cards.
- The dashboard reads the latest JSON snapshot for each competitor from the `data/` directory.
