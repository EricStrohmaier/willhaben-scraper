# Scraping Service

A self-hosted scraping service built with Node.js, Puppeteer, and Turso/SQLite. Designed to run multiple scraping pipelines with AI-powered matching and notifications.

Currently ships with a **Willhaben apartment scraper** for monitoring rental listings in Austria.

## How It Works

```
Job (1..n URLs) ──► List Scraper ──► Detail Scraper ──► Database ──► OpenAI Matcher ──► Notification
                     (pagination)     (each listing)     (Turso)      (gpt-4o-mini)      (webhook)
```

1. **Scrape listing pages** — Puppeteer navigates willhaben search results, handles pagination, extracts all listing previews
2. **Scrape detail pages** — Visits each individual listing to extract full info (description, price breakdown, equipment, images, contact)
3. **Store in database** — Upserts into Turso (remote) or local SQLite. Tracks new vs. updated listings, marks disappeared ones as inactive
4. **Match via OpenAI** — New listings are scored against that job's criteria using gpt-4o-mini
5. **Notify** — Matching listings trigger a webhook notification (Slack, Discord, email, etc.)

## Jobs

A **job** is one search: a set of willhaben URLs plus the criteria used to score
what they return. Jobs are defined in `src/config/jobs.ts` and run independently
— each has its own criteria, budget, and notifications.

```ts
{
  id: "vienna",                  // stable slug, stored on every listing
  name: "Vienna (6th/7th/8th)",
  urls: [ ... ],                 // any number of willhaben search URLs
  enabled: true,
  softCapEur: 1400,              // listings above this are scored down, not excluded
  maxPages: 5,                   // search-result pages per URL
  maxDetailsPerRun: 90,          // detail-page cap per run, shared across the job's URLs
  locationGuidance: "...",       // appended to the shared criteria
}
```

Every listing and run row is tagged with its `job_id`. This scoping matters:
without it, each job's "mark absent listings inactive" sweep would deactivate
every other job's listings on every run, and each job would spend tokens
re-scoring the other's listings against its own criteria.

`maxDetailsPerRun` bounds the slowest part of the pipeline (~2-4s per detail
page). Listings beyond the cap stay in the DB as previews and are picked up on
the next run, so a broad search URL degrades gracefully instead of timing out.

## Project Structure

```
src/
├── server.ts                      # HTTP API server
├── cli.ts                         # CLI for manual runs
├── pipeline.ts                    # Full pipeline orchestrator (scrape → match → notify)
├── config/
│   └── jobs.ts                    # Search jobs: URLs, criteria, budgets
├── lib/
│   ├── browser.ts                 # Puppeteer singleton (local + remote Bright Data)
│   ├── fetch-page.ts              # 3-tier fetching (got-scraping → Puppeteer → remote)
│   ├── matcher.ts                 # OpenAI listing matcher
│   └── notify.ts                  # Webhook notifications
├── scrapers/
│   ├── index.ts                   # Scraper registry
│   └── willhaben/
│       ├── index.ts               # Willhaben orchestrator
│       ├── list-scraper.ts        # Search result page scraper + pagination
│       ├── detail-scraper.ts      # Individual listing detail scraper
│       └── types.ts               # TypeScript types
└── db/
    ├── turso.ts                   # Turso/SQLite client
    ├── migrate.ts                 # Schema migrations
    └── queries.ts                 # CRUD operations
```

## Quick Start

```bash
# Install dependencies
npm install

# Run database migrations
npm run db:migrate

# Start the dev server
npm run dev

# Or build and run production
npm run build
npm start
```

## CLI Usage

```bash
# Scrape listings only (no AI matching), all enabled jobs
npm run scrape
npm run scrape -- "https://www.willhaben.at/iad/immobilien/mietwohnungen/wien?rows=90"

# Full pipeline: scrape + match + notify, all enabled jobs
npm run run-pipeline

# View configuration and stored data
npx tsx src/cli.ts jobs        # Configured search jobs
npx tsx src/cli.ts listings    # Active listings in DB (tagged by job)
npx tsx src/cli.ts matches     # Unnotified matches
npx tsx src/cli.ts runs        # Recent pipeline runs

# Options
npx tsx src/cli.ts run --job=vienna    # Run one job only
npx tsx src/cli.ts listings --job=vienna
npm run scrape -- --pages=5            # Override the job's maxPages
npm run run-pipeline -- --no-match     # Skip OpenAI matching
npm run run-pipeline -- --no-notify    # Skip notifications
```

Passing a bare URL creates an ad-hoc job whose id is derived from the URL, so
its listings stay isolated from the configured jobs. If the URL matches a
configured job, that job is used instead.

## API Endpoints

| Method     | Endpoint      | Description                                                        |
| ---------- | ------------- | ------------------------------------------------------------------ |
| `GET`      | `/health`     | Service status, active jobs, registered scrapers                   |
| `GET`      | `/jobs`       | List active scraping jobs                                          |
| `POST`     | `/run`        | Trigger full pipeline: `{}` runs all enabled jobs, `{"job":"vienna"}` or `{"jobs":[...]}` runs specific ones, `{"url":"..."}` runs ad-hoc (fire-and-forget, returns 202) |
| `POST`     | `/scrape`     | Run a specific scraper: `{ "scraper": "willhaben", "url": "..." }` |
| `GET`      | `/listings`   | All active listings from DB                                        |
| `GET`      | `/matches`    | Unnotified matches (score >= 60)                                   |
| `GET`      | `/runs`       | Recent pipeline run history                                        |
| `GET/POST` | `/screenshot` | Take a screenshot of any URL                                       |
| `POST`     | `/cancel`     | Cancel a specific job: `{ "url": "..." }`                          |
| `POST`     | `/cancel-all` | Cancel all active jobs                                             |

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
# Server
PORT=3100
API_KEY=your-secret-key      # Optional: require Bearer auth
MAX_CONCURRENT=3              # Max parallel scraping jobs

# Database (defaults to local SQLite at data/scraping.db)
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-token

# OpenAI (for AI matching)
OPENAI_API_KEY=sk-...

# Notifications
NOTIFICATION_WEBHOOK=https://hooks.slack.com/services/...

# Optional: Bright Data remote browser for bot-heavy sites
SCRAPING_BROWSER_WS=wss://brd-customer-XXXX-zone-scraping_browser1:PASSWORD@brd.superproxy.io:9222
```

## Daily Cron

Set up a cron job or use Coolify's scheduled tasks to hit the `/run` endpoint daily:

```bash
# Via curl (e.g., in a cron job)
curl -X POST http://localhost:3100/run \
  -H "Authorization: Bearer your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.willhaben.at/iad/immobilien/mietwohnungen/tirol/innsbruck?rows=90"}'
```

## Docker / Coolify

```bash
# Build and run
docker compose up -d

# Or build manually
docker build -t scraping .
docker run -p 3100:3100 --env-file .env scraping
```

The Docker image uses Node 22 with system Chromium. Resource limits: 2GB RAM, 2 CPUs.

## Adding New Scrapers

1. Create a new directory under `src/scrapers/your-scraper/`
2. Export a `run(url, options?, signal?)` function
3. Register it in `src/scrapers/index.ts`:

```ts
import { run as runYourScraper } from "./your-scraper/index.js";
registerScraper("your-scraper", runYourScraper);
```

The scraper becomes available via `POST /scrape { "scraper": "your-scraper", "url": "..." }`.

## Tech Stack

- **Runtime**: Node.js 22, TypeScript, ES modules
- **Browser**: Puppeteer (Chromium)
- **HTTP scraping**: got-scraping (anti-bot headers)
- **HTML parsing**: Cheerio
- **Database**: Turso (libSQL) / local SQLite
- **AI**: OpenAI gpt-4o-mini
- **Deployment**: Docker, Coolify-ready
