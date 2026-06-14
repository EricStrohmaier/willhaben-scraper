import { migrate } from "./db/migrate.js";
import { createRun, finishRun, getUnmatchedListings } from "./db/queries.js";
import { scrapeWillhaben } from "./scrapers/willhaben/index.js";
import type { WillhabenListing } from "./scrapers/willhaben/types.js";
import { matchListings, hasOpenAI, getCriteriaHash } from "./lib/matcher.js";
import { sendNewMatchNotifications } from "./lib/notify.js";

export interface PipelineOptions {
  url: string;
  maxPages?: number;
  signal?: AbortSignal;
  skipMatch?: boolean;
  skipNotify?: boolean;
  onRunCreated?: (runId: number) => void;
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
  opts.onRunCreated?.(runId);
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
    } else if (!opts.skipMatch && hasOpenAI()) {
      const unmatchedRows = await getUnmatchedListings(getCriteriaHash());
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
