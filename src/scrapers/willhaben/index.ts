import { scrapeAllListPages } from "./list-scraper.js";
import { scrapeDetailPage } from "./detail-scraper.js";
import { delay } from "../../lib/abort.js";
import { resolveJob } from "../../config/jobs.js";
import {
  upsertPreview,
  upsertListing,
  getScrapedListingIds,
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
  const { url, jobId, maxPages, maxDetails, signal } = opts;

  const previews = await scrapeAllListPages(url, {
    maxPages,
    signal,
    batchSize: 25,
    onBatch: async (batch) => {
      for (const p of batch) {
        await upsertPreview(p, jobId);
      }
    },
  });

  if (previews.length === 0) {
    console.log("[willhaben] No listings found");
    return {
      listings: [],
      totalFound: 0,
      pagesScraped: 0,
      newListings: 0,
      detailsAttempted: 0,
      activeIds: [],
      complete: true,
    };
  }

  const allIds = previews.map((p) => p.id);
  const alreadyScraped = await getScrapedListingIds(allIds);
  let toScrape = previews.filter((p) => !alreadyScraped.has(p.id));

  // Bound detail-page work so a broad search URL can't run past the CI timeout.
  // Anything deferred is still in the DB as a preview and gets picked up next run.
  let deferred = 0;
  if (maxDetails != null && toScrape.length > maxDetails) {
    deferred = toScrape.length - maxDetails;
    toScrape = toScrape.slice(0, maxDetails);
    console.log(
      `[willhaben] Capping detail scrapes at ${maxDetails}; deferring ${deferred} to the next run`
    );
  }

  if (alreadyScraped.size > 0) {
    console.log(
      `[willhaben] Skipping ${alreadyScraped.size} already-scraped listings, scraping ${toScrape.length} new detail pages...`
    );
  } else {
    console.log(
      `[willhaben] Scraping ${toScrape.length} detail pages...`
    );
  }

  const listings: WillhabenListing[] = [];
  let newCount = 0;
  let failures = 0;
  const delayMs = 2000;

  for (let i = 0; i < toScrape.length; i++) {
    if (signal?.aborted) break;

    const preview = toScrape[i];
    try {
      const listing = await scrapeDetailPage(preview, signal);
      listings.push(listing);

      const isNew = await upsertListing(listing, jobId);
      if (isNew) newCount++;

      console.log(
        `[willhaben] ${i + 1}/${toScrape.length} ${isNew ? "NEW" : "UPD"} | €${listing.price ?? "?"} | ${listing.title?.substring(0, 50)}`
      );
    } catch (err) {
      failures++;
      console.error(
        `[willhaben] ${i + 1}/${toScrape.length} FAIL | ${preview.title?.substring(0, 50)} | ${err}`
      );
    }

    if (i < toScrape.length - 1 && delayMs > 0) {
      await delay(delayMs, signal);
    }
  }

  // Previews are authoritative for "still listed" — a detail-fetch failure or a
  // deferred listing must not look like a delisting.
  const activeIds = allIds;
  const complete = !signal?.aborted && failures === 0;

  console.log(
    `[willhaben] Complete: ${listings.length} detail-scraped, ${newCount} new, ${listings.length - newCount} updated, ${failures} failed`
  );

  return {
    listings,
    totalFound: previews.length,
    pagesScraped: Math.ceil(previews.length / 90),
    newListings: newCount,
    detailsAttempted: listings.length + failures,
    activeIds,
    complete,
  };
}

export async function run(
  url: string,
  options?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<ScrapeResult> {
  return scrapeWillhaben({
    url,
    jobId: (options?.jobId as string) ?? resolveJob(url).id,
    maxPages: (options?.maxPages as number) ?? 10,
    maxDetails: options?.maxDetails as number | undefined,
    signal,
  });
}
