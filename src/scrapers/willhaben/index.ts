import { scrapeAllListPages } from "./list-scraper.js";
import { scrapeDetailPage } from "./detail-scraper.js";
import {
  upsertPreview,
  upsertListing,
  markInactiveExcept,
} from "../../db/queries.js";
import type {
  ScrapeOptions,
  ScrapeResult,
  WillhabenListing,
  WillhabenListingPreview,
} from "./types.js";

export type {
  WillhabenListing,
  WillhabenListingPreview,
  ScrapeResult,
} from "./types.js";

export async function scrapeWillhaben(
  opts: ScrapeOptions
): Promise<ScrapeResult> {
  const { url, maxPages, signal } = opts;

  const previews = await scrapeAllListPages(url, {
    maxPages,
    signal,
    batchSize: 25,
    onBatch: async (batch) => {
      for (const p of batch) {
        await upsertPreview(p);
      }
    },
  });

  if (previews.length === 0) {
    console.log("[willhaben] No listings found");
    return { listings: [], totalFound: 0, pagesScraped: 0, newListings: 0 };
  }

  console.log(
    `[willhaben] Scraping ${previews.length} detail pages (saving each to DB immediately)...`
  );

  const listings: WillhabenListing[] = [];
  let newCount = 0;
  const delayMs = 2000;

  for (let i = 0; i < previews.length; i++) {
    if (signal?.aborted) break;

    const preview = previews[i];
    try {
      const listing = await scrapeDetailPage(preview, signal);
      listings.push(listing);

      const isNew = await upsertListing(listing);
      if (isNew) newCount++;

      console.log(
        `[willhaben] ${i + 1}/${previews.length} ${isNew ? "NEW" : "UPD"} | €${listing.price ?? "?"} | ${listing.title?.substring(0, 50)}`
      );
    } catch (err) {
      console.error(
        `[willhaben] ${i + 1}/${previews.length} FAIL | ${preview.title?.substring(0, 50)} | ${err}`
      );
    }

    if (i < previews.length - 1 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  const activeIds = listings.map((l) => l.id);
  await markInactiveExcept(activeIds);

  console.log(
    `[willhaben] Complete: ${listings.length} total, ${newCount} new, ${listings.length - newCount} updated`
  );

  return {
    listings,
    totalFound: previews.length,
    pagesScraped: Math.ceil(previews.length / 90),
    newListings: newCount,
  };
}

export async function run(
  url: string,
  options?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<ScrapeResult> {
  return scrapeWillhaben({
    url,
    maxPages: (options?.maxPages as number) ?? 10,
    signal,
  });
}
