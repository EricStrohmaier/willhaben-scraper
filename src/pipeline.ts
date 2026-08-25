import { migrate } from "./db/migrate.js";
import {
  createRun,
  finishRun,
  getUnmatchedListings,
  markInactiveExcept,
} from "./db/queries.js";
import { scrapeWillhaben } from "./scrapers/willhaben/index.js";
import type { WillhabenListing } from "./scrapers/willhaben/types.js";
import { matchListings, hasOpenAI, getCriteriaHash } from "./lib/matcher.js";
import { sendNewMatchNotifications } from "./lib/notify.js";
import { buildCriteria, type SearchJob } from "./config/jobs.js";

export interface PipelineOptions {
  job: SearchJob;
  /** Overrides the job's own maxPages. Mainly for ad-hoc CLI runs. */
  maxPages?: number;
  signal?: AbortSignal;
  skipMatch?: boolean;
  skipNotify?: boolean;
  onRunCreated?: (runId: number) => void;
}

export interface PipelineResult {
  runId: number;
  jobId: string;
  listingsFound: number;
  newListings: number;
  matchesFound: number;
  duration: number;
  status: "completed" | "cancelled" | "error";
  error?: string;
}

export async function runPipeline(
  opts: PipelineOptions
): Promise<PipelineResult> {
  const start = Date.now();
  const job = opts.job;

  await migrate();

  const runId = await createRun(job.id);
  opts.onRunCreated?.(runId);
  console.log(`[pipeline] Run #${runId} started for job "${job.id}"`);

  const stats = { listingsFound: 0, newListings: 0, matchesFound: 0 };
  let status: "completed" | "cancelled" | "error" = "completed";
  let errorMsg: string | undefined;

  try {
    // Scrape every URL belonging to this job, pooling the IDs so the
    // inactive sweep below sees the job's full result set at once.
    const activeIds: string[] = [];
    let allComplete = true;
    // Shared across the job's URLs, not per URL — otherwise a job with 3 URLs
    // would fetch 3x the intended number of detail pages and risk the timeout.
    let detailBudget = job.maxDetailsPerRun;

    for (const url of job.urls) {
      if (opts.signal?.aborted) break;

      console.log(
        `[pipeline] Scraping ${url} (detail budget left: ${detailBudget})`
      );
      const scrapeResult = await scrapeWillhaben({
        url,
        jobId: job.id,
        maxPages: opts.maxPages ?? job.maxPages,
        maxDetails: detailBudget,
        signal: opts.signal,
      });

      stats.listingsFound += scrapeResult.totalFound;
      stats.newListings += scrapeResult.newListings;
      detailBudget = Math.max(0, detailBudget - scrapeResult.detailsAttempted);
      // Keep walking the remaining URLs even at budget 0: previews are what
      // make activeIds complete, and an incomplete set breaks the sweep below.
      activeIds.push(...scrapeResult.activeIds);
      if (!scrapeResult.complete) allComplete = false;
    }

    // Only sweep when the job's whole result set was collected cleanly.
    // A partial set would wrongly deactivate listings that are still live.
    if (opts.signal?.aborted) {
      status = "cancelled";
      errorMsg = "Cancelled by user";
    } else if (allComplete && activeIds.length > 0) {
      await markInactiveExcept(activeIds, job.id);
    } else if (!allComplete) {
      console.log(
        `[pipeline] Skipping inactive sweep for "${job.id}" — scrape was incomplete`
      );
    }

    if (status !== "cancelled" && !opts.skipMatch && hasOpenAI()) {
      const criteria = buildCriteria(job);
      const unmatchedRows = await getUnmatchedListings(
        getCriteriaHash(criteria),
        job.id
      );
      const toMatch: WillhabenListing[] = unmatchedRows.map((r) => ({
        id: String(r.id),
        url: String(r.url),
        title: String(r.title ?? ""),
        price: r.price != null ? Number(r.price) : null,
        priceText: r.price_text != null ? String(r.price_text) : null,
        sizeM2: r.size_m2 != null ? Number(r.size_m2) : null,
        rooms: r.rooms != null ? Number(r.rooms) : null,
        address: r.address != null ? String(r.address) : null,
        district: r.district != null ? String(r.district) : null,
        imageUrl: null,
        postalCode: r.postal_code != null ? String(r.postal_code) : null,
        fullAddress: r.full_address != null ? String(r.full_address) : null,
        description: r.description != null ? String(r.description) : null,
        locationDescription: r.location_description != null ? String(r.location_description) : null,
        otherDescription: r.other_description != null ? String(r.other_description) : null,
        attributes: r.attributes ? JSON.parse(String(r.attributes)) : {},
        equipment: r.equipment ? JSON.parse(String(r.equipment)) : {},
        priceLabel: r.price_label != null ? String(r.price_label) : null,
        deposit: r.deposit != null ? Number(r.deposit) : null,
        depositText: r.deposit_text != null ? String(r.deposit_text) : null,
        priceInfo: r.price_info ? JSON.parse(String(r.price_info)) : {},
        images: r.images ? JSON.parse(String(r.images)) : [],
        landlord: r.landlord != null ? String(r.landlord) : null,
        landlordType: r.landlord_type != null ? String(r.landlord_type) : null,
        contactInfo: r.contact_info != null ? String(r.contact_info) : null,
        lastModified: r.last_modified != null ? String(r.last_modified) : null,
        willhabenCode: r.willhaben_code != null ? String(r.willhaben_code) : null,
        heatingInfo: r.heating_info != null ? String(r.heating_info) : null,
        additionalInfoUrls: r.additional_info_urls ? JSON.parse(String(r.additional_info_urls)) : [],
      }));

      if (toMatch.length > 0) {
        console.log(
          `[pipeline] Matching ${toMatch.length} unmatched listings with OpenAI...`
        );
        const results = await matchListings(toMatch, {
          criteria,
          signal: opts.signal,
          runId,
        });
        stats.matchesFound = results.filter((r) => r.score >= 60).length;
      }
    } else if (!hasOpenAI()) {
      console.log("[pipeline] Skipping matching (OPENAI_API_KEY not set)");
    }

    if (!opts.skipNotify && !opts.signal?.aborted) {
      await sendNewMatchNotifications();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAbort = opts.signal?.aborted || msg === "Aborted" || msg.includes("abort");

    status = isAbort ? "cancelled" : "error";
    errorMsg = isAbort ? "Cancelled by user" : msg;

    console.error(
      `[pipeline] Run #${runId} ${status}: ${errorMsg}`
    );
  } finally {
    const duration = Date.now() - start;

    await finishRun(runId, stats, status, errorMsg).catch((e) =>
      console.error(`[pipeline] Failed to update run #${runId}: ${e}`)
    );

    console.log(
      `[pipeline] Run #${runId} (${job.id}) ${status}: ${stats.listingsFound} found, ${stats.newListings} new, ${stats.matchesFound} matches (${duration}ms)`
    );

    return {
      runId,
      jobId: job.id,
      ...stats,
      duration,
      status,
      error: errorMsg,
    };
  }
}
