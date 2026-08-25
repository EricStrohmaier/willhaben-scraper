import "dotenv/config";
import http from "node:http";
import {
  getLocalBrowser,
  closeLocalBrowser,
  hasRemoteBrowser,
  createPage,
} from "./lib/browser.js";
import {
  runScraper,
  getScraperNames,
  type ScrapeRequest,
} from "./scrapers/index.js";
import { migrate } from "./db/migrate.js";
import { hasTurso } from "./db/turso.js";
import { getActiveListings, getRecentRuns, getUnnotifiedMatches } from "./db/queries.js";
import { runPipeline } from "./pipeline.js";
import { hasOpenAI } from "./lib/matcher.js";
import {
  getEnabledJobs,
  getJob,
  resolveJob,
  type SearchJob,
} from "./config/jobs.js";

const PORT = parseInt(process.env.PORT || "3100", 10);
const API_KEY = process.env.API_KEY || "";
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "3", 10);

let activeJobs = 0;

interface ActiveJob {
  controller: AbortController;
  scraper: string;
  url: string;
  startedAt: number;
}
const activeJobMap = new Map<string, ActiveJob>();

function jobKey(scraper: string, url: string) {
  return `${scraper}:${url.replace(/\/+$/, "").toLowerCase()}`;
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function parseBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

function checkAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse
): boolean {
  if (!API_KEY) return true;
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${API_KEY}`) {
    json(res, 401, { error: "Unauthorized" });
    return false;
  }
  return true;
}

// ─── Screenshot with Puppeteer ─────────────────────────────────────────────

interface ScreenshotOptions {
  url: string;
  width?: number;
  height?: number;
  format?: "png" | "jpeg";
  quality?: number;
  delay?: number;
  timeout?: number;
  fullPage?: boolean;
}

async function takeScreenshot(opts: ScreenshotOptions): Promise<Buffer> {
  const {
    url,
    width = 1280,
    height = 800,
    format = "png",
    delay = 500,
    timeout = 10000,
    fullPage = false,
  } = opts;

  const page = await createPage();
  await page.setViewport({ width, height });

  try {
    await page.goto(url, { waitUntil: "load", timeout });
    await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});

    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
    }

    for (const selector of [
      '[class*="cookie"] button[class*="accept"]',
      '[class*="consent"] button[class*="accept"]',
      'button[id*="accept"]',
      '[aria-label="Accept all"]',
      '[aria-label="Close"]',
    ]) {
      const btn = await page.$(selector);
      if (btn) {
        await btn.click().catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
        break;
      }
    }

    const buffer = await page.screenshot({
      type: format,
      fullPage,
      ...(format === "jpeg" && opts.quality ? { quality: opts.quality } : {}),
    });
    return Buffer.from(buffer);
  } finally {
    await page.close();
  }
}

// ─── HTTP Server ────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (pathname === "/health") {
    return json(res, 200, {
      ok: true,
      active: activeJobs,
      scrapers: getScraperNames(),
      inProgress: [...activeJobMap.keys()],
    });
  }

  if (pathname === "/jobs" && req.method === "GET") {
    if (!checkAuth(req, res)) return;
    const jobs = [...activeJobMap.entries()].map(([, job]) => ({
      url: job.url,
      scraper: job.scraper,
      startedAt: new Date(job.startedAt).toISOString(),
      elapsedMs: Date.now() - job.startedAt,
    }));
    return json(res, 200, { active: activeJobs, jobs });
  }

  if (pathname === "/cancel-all" && req.method === "POST") {
    if (!checkAuth(req, res)) return;
    const cancelled: string[] = [];
    for (const [, job] of activeJobMap) {
      job.controller.abort();
      cancelled.push(job.url);
      console.log(`[cancel] Cancelled: ${job.url} (${job.scraper})`);
    }
    return json(res, 200, { cancelled: cancelled.length, urls: cancelled });
  }

  if (pathname === "/cancel" && req.method === "POST") {
    if (!checkAuth(req, res)) return;
    const body = await parseBody(req);
    let targetUrl: string | undefined;
    try {
      targetUrl = JSON.parse(body).url;
    } catch {
      /* */
    }
    if (!targetUrl) return json(res, 400, { error: "Missing url in body" });
    const normalized = targetUrl.replace(/\/+$/, "").toLowerCase();

    let found: ActiveJob | undefined;
    for (const [key, job] of activeJobMap) {
      if (key.endsWith(`:${normalized}`)) {
        found = job;
        break;
      }
    }
    if (!found) return json(res, 404, { error: "No active job for that URL" });
    found.controller.abort();
    console.log(`[cancel] Cancelled: ${found.url} (${found.scraper})`);
    return json(res, 200, { cancelled: true, url: found.url });
  }

  // ─── Screenshot endpoint ────────────────────────────────────────────────

  if (pathname === "/screenshot" && (req.method === "GET" || req.method === "POST")) {
    if (!checkAuth(req, res)) return;

    if (activeJobs >= MAX_CONCURRENT) {
      return json(res, 429, { error: "Too many requests, try again shortly" });
    }

    let options: ScreenshotOptions;

    try {
      if (req.method === "POST") {
        const body = await parseBody(req);
        options = JSON.parse(body);
      } else {
        const targetUrl = url.searchParams.get("url");
        if (!targetUrl)
          return json(res, 400, { error: "Missing url parameter" });
        options = {
          url: targetUrl,
          width: parseInt(url.searchParams.get("width") || "1280", 10),
          height: parseInt(url.searchParams.get("height") || "800", 10),
          format: (url.searchParams.get("format") as "png" | "jpeg") || "png",
          delay: parseInt(url.searchParams.get("delay") || "500", 10),
          timeout: parseInt(url.searchParams.get("timeout") || "10000", 10),
        };
      }
    } catch {
      return json(res, 400, { error: "Invalid request body" });
    }

    if (!options.url) return json(res, 400, { error: "Missing url" });

    activeJobs++;
    const start = Date.now();
    console.log(
      `[screenshot] Starting: url=${options.url}, ${options.width || 1280}x${options.height || 800}`
    );

    try {
      const result = await takeScreenshot(options);
      const elapsed = Date.now() - start;
      const mimeType = options.format === "jpeg" ? "image/jpeg" : "image/png";

      console.log(`[screenshot] Done: ${result.length} bytes (${elapsed}ms)`);

      res.writeHead(200, {
        "Content-Type": mimeType,
        "Content-Length": result.length,
        "X-Screenshot-Time-Ms": elapsed.toString(),
      });
      res.end(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Screenshot failed";
      console.error(`[screenshot] Error: ${message} (${Date.now() - start}ms)`);
      json(res, 500, { error: message });
    } finally {
      activeJobs--;
    }
    return;
  }

  // ─── Generic scrape endpoint ────────────────────────────────────────────

  if (pathname === "/scrape" && (req.method === "GET" || req.method === "POST")) {
    if (!checkAuth(req, res)) return;

    if (activeJobs >= MAX_CONCURRENT) {
      return json(res, 429, { error: "Too many requests, try again shortly" });
    }

    let scrapeReq: ScrapeRequest;

    try {
      if (req.method === "POST") {
        const body = await parseBody(req);
        scrapeReq = JSON.parse(body);
      } else {
        const scraper = url.searchParams.get("scraper");
        const targetUrl = url.searchParams.get("url");
        if (!scraper || !targetUrl)
          return json(res, 400, { error: "Missing scraper or url parameter" });
        scrapeReq = { scraper, url: targetUrl };
      }
    } catch {
      return json(res, 400, { error: "Invalid request body" });
    }

    if (!scrapeReq.scraper || !scrapeReq.url) {
      return json(res, 400, { error: "Missing scraper or url" });
    }

    const key = jobKey(scrapeReq.scraper, scrapeReq.url);
    if (activeJobMap.has(key)) {
      return json(res, 200, { skipped: true, reason: "already_in_progress" });
    }

    const controller = new AbortController();
    activeJobs++;
    activeJobMap.set(key, {
      controller,
      scraper: scrapeReq.scraper,
      url: scrapeReq.url,
      startedAt: Date.now(),
    });

    const start = Date.now();
    console.log(
      `[scrape] Starting: scraper=${scrapeReq.scraper}, url=${scrapeReq.url}, active=${activeJobs}/${MAX_CONCURRENT}`
    );

    try {
      const result = await runScraper(scrapeReq, controller.signal);
      const elapsed = Date.now() - start;
      console.log(`[scrape] Done: scraper=${scrapeReq.scraper} (${elapsed}ms)`);
      json(res, 200, { ...result, elapsed_ms: elapsed });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Scrape failed";
      console.error(`[scrape] Error: ${message} (${Date.now() - start}ms)`);
      json(res, 500, { error: message });
    } finally {
      activeJobs--;
      activeJobMap.delete(key);
    }
    return;
  }

  // ─── Pipeline: full scrape + match + notify ─────────────────────────────

  if (pathname === "/run" && req.method === "POST") {
    if (!checkAuth(req, res)) return;

    if (activeJobs >= MAX_CONCURRENT) {
      return json(res, 429, { error: "Too many requests, try again shortly" });
    }

    let urls: string[] = [];
    let jobIds: string[] = [];
    let maxPages: number | undefined;

    try {
      const body = await parseBody(req);
      if (body) {
        const parsed = JSON.parse(body);
        if (parsed.url) urls = [parsed.url];
        if (parsed.urls) urls = parsed.urls;
        if (parsed.job) jobIds = [parsed.job];
        if (parsed.jobs) jobIds = parsed.jobs;
        if (parsed.maxPages) maxPages = parsed.maxPages;
      }
    } catch {
      /* use defaults */
    }

    // Explicit URLs win, then explicit job ids, then every enabled job.
    let targetJobs: SearchJob[];
    if (urls.length > 0) {
      targetJobs = urls.map((u) => resolveJob(u));
    } else if (jobIds.length > 0) {
      const unknown = jobIds.filter((id) => !getJob(id));
      if (unknown.length > 0) {
        return json(res, 400, { error: `Unknown job(s): ${unknown.join(", ")}` });
      }
      targetJobs = jobIds.map((id) => getJob(id)!);
    } else {
      targetJobs = getEnabledJobs();
    }

    if (targetJobs.length === 0) {
      return json(res, 400, { error: "No enabled jobs configured" });
    }

    activeJobs++;
    const controller = new AbortController();
    const key = jobKey("pipeline", targetJobs[0].urls[0]);
    activeJobMap.set(key, {
      controller,
      scraper: "pipeline",
      url: targetJobs.flatMap((j) => j.urls).join(", "),
      startedAt: Date.now(),
    });

    json(res, 202, {
      accepted: true,
      jobs: targetJobs.map((j) => j.id),
      message: `Pipeline started for ${targetJobs.length} job(s)`,
    });

    (async () => {
      for (const job of targetJobs) {
        if (controller.signal.aborted) break;
        const result = await runPipeline({ job, maxPages, signal: controller.signal });
        console.log(`[pipeline] Complete for job ${job.id}:`, result);
      }
    })()
      .catch((err) => {
        console.error(`[pipeline] Failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        activeJobs--;
        activeJobMap.delete(key);
      });

    return;
  }

  // ─── Data endpoints ────────────────────────────────────────────────────

  if (pathname === "/listings" && req.method === "GET") {
    if (!checkAuth(req, res)) return;
    try {
      const listings = await getActiveListings();
      return json(res, 200, { count: listings.length, listings });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (pathname === "/matches" && req.method === "GET") {
    if (!checkAuth(req, res)) return;
    try {
      const matches = await getUnnotifiedMatches();
      return json(res, 200, { count: matches.length, matches });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (pathname === "/runs" && req.method === "GET") {
    if (!checkAuth(req, res)) return;
    try {
      const runs = await getRecentRuns();
      return json(res, 200, { runs });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  json(res, 404, { error: "Not found" });
});

// ─── Startup ──────────────────────────────────────────────────────────────

async function start() {
  await migrate();

  server.listen(PORT, () => {
    console.log(`Scraping service running on :${PORT}`);
    console.log(`  Auth: ${API_KEY ? "enabled" : "disabled (set API_KEY to enable)"}`);
    console.log(`  Max concurrent: ${MAX_CONCURRENT}`);
    console.log(`  Remote browser: ${hasRemoteBrowser() ? "configured" : "none (set SCRAPING_BROWSER_WS)"}`);
    console.log(`  OpenAI: ${hasOpenAI() ? "configured" : "disabled (set OPENAI_API_KEY)"}`);
    console.log(`  DB: ${hasTurso() ? "Turso" : "local SQLite (data/scraping.db)"}`);
    console.log(`  Scrapers: ${getScraperNames().join(", ")}`);
    console.log(`  Endpoints: /health, /jobs, /cancel, /screenshot, /scrape, /run, /listings, /matches, /runs`);
  });
}

start();

process.on("SIGTERM", async () => {
  await closeLocalBrowser();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await closeLocalBrowser();
  process.exit(0);
});
