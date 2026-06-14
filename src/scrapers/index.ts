/**
 * Scraper registry — add new scrapers here.
 *
 * Each scraper is a module that exports a `run` function matching the
 * `ScraperHandler` type. Register it in the `scrapers` map below, and
 * it becomes available via POST /scrape { scraper: "name", ... }.
 */

export interface ScrapeRequest {
  /** Which scraper to run */
  scraper: string;
  /** Target URL to scrape */
  url: string;
  /** Arbitrary options forwarded to the scraper handler */
  options?: Record<string, unknown>;
}

export interface ScrapeResult {
  scraper: string;
  url: string;
  data: unknown;
  /** Any message or warning from the scraper */
  message?: string | null;
}

export type ScraperHandler = (
  url: string,
  options?: Record<string, unknown>,
  signal?: AbortSignal
) => Promise<unknown>;

// ─── Registry ──────────────────────────────────────────────────────────────

const scrapers = new Map<string, ScraperHandler>();

export function registerScraper(name: string, handler: ScraperHandler) {
  scrapers.set(name, handler);
}

export function getScraperNames(): string[] {
  return [...scrapers.keys()];
}

export async function runScraper(
  req: ScrapeRequest,
  signal?: AbortSignal
): Promise<ScrapeResult> {
  const handler = scrapers.get(req.scraper);
  if (!handler) {
    throw new Error(
      `Unknown scraper "${req.scraper}". Available: ${getScraperNames().join(", ") || "(none registered)"}`
    );
  }

  const data = await handler(req.url, req.options, signal);

  return {
    scraper: req.scraper,
    url: req.url,
    data,
  };
}

// ─── Auto-register built-in scrapers ──────────────────────────────────────

import { run as runWillhaben } from "./willhaben/index.js";
registerScraper("willhaben", runWillhaben);
