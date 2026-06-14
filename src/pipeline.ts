import { migrate } from "./db/migrate.js";
import { createRun, finishRun, getNewListingsSince } from "./db/queries.js";
import { scrapeWillhaben } from "./scrapers/willhaben/index.js";
import { matchListings, hasOpenAI } from "./lib/matcher.js";
import { sendNewMatchNotifications } from "./lib/notify.js";

export interface PipelineOptions {
  url: string;
  maxPages?: number;
  signal?: AbortSignal;
  skipMatch?: boolean;
  skipNotify?: boolean;
}

export interface PipelineResult {
  runId: number;
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

  await migrate();

  const runId = await createRun();
  console.log(`[pipeline] Run #${runId} started`);

  const stats = { listingsFound: 0, newListings: 0, matchesFound: 0 };
  let status: "completed" | "cancelled" | "error" = "completed";
  let errorMsg: string | undefined;

  try {
    const scrapeResult = await scrapeWillhaben({
      url: opts.url,
      maxPages: opts.maxPages,
      signal: opts.signal,
    });

    stats.listingsFound = scrapeResult.totalFound;
    stats.newListings = scrapeResult.newListings;

    if (opts.signal?.aborted) {
      status = "cancelled";
      errorMsg = "Cancelled by user";
    } else if (
      !opts.skipMatch &&
      hasOpenAI() &&
      scrapeResult.newListings > 0
    ) {
      const runStartIso = new Date(start).toISOString();
      const newRows = await getNewListingsSince(runStartIso);
      const newIds = new Set(newRows.map((r) => String(r.id)));
      const toMatch = scrapeResult.listings.filter((l) => newIds.has(l.id));

      if (toMatch.length > 0) {
        console.log(
          `[pipeline] Matching ${toMatch.length} new listings with OpenAI...`
        );
        const results = await matchListings(toMatch, {
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
      `[pipeline] Run #${runId} ${status}: ${stats.listingsFound} found, ${stats.newListings} new, ${stats.matchesFound} matches (${duration}ms)`
    );

    return {
      runId,
      ...stats,
      duration,
      status,
      error: errorMsg,
    };
  }
}
