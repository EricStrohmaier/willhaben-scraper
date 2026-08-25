import { getDb } from "./turso.js";
import type {
  WillhabenListing,
  WillhabenListingPreview,
} from "../scrapers/willhaben/types.js";

// ─── Listings ──────────────────────────────────────────────────────────────

export async function upsertPreview(
  preview: WillhabenListingPreview,
  jobId: string
): Promise<boolean> {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = await db.execute({
    sql: "SELECT id FROM listings WHERE id = ?",
    args: [preview.id],
  });

  if (existing.rows.length > 0) {
    // COALESCE, not assignment: if a listing shows up in two jobs' searches,
    // the first job to see it keeps ownership. Reassigning would make the two
    // jobs fight over is_active every run.
    await db.execute({
      sql: `UPDATE listings SET
        title = ?, price = ?, price_text = ?, size_m2 = ?, rooms = ?,
        address = ?, district = ?, last_seen_at = ?, is_active = 1,
        job_id = COALESCE(job_id, ?)
        WHERE id = ?`,
      args: [
        preview.title, preview.price, preview.priceText, preview.sizeM2,
        preview.rooms, preview.address, preview.district, now, jobId, preview.id,
      ],
    });
    return false;
  }

  await db.execute({
    sql: `INSERT INTO listings (id, url, title, price, price_text, size_m2, rooms,
      address, district, job_id, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      preview.id, preview.url, preview.title, preview.price, preview.priceText,
      preview.sizeM2, preview.rooms, preview.address, preview.district, jobId,
      now, now,
    ],
  });
  return true;
}

export async function upsertListing(
  listing: WillhabenListing,
  jobId: string
): Promise<boolean> {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = await db.execute({
    sql: "SELECT id FROM listings WHERE id = ?",
    args: [listing.id],
  });

  if (existing.rows.length > 0) {
    await db.execute({
      sql: `UPDATE listings SET
        title = ?, price = ?, price_text = ?, size_m2 = ?, rooms = ?,
        address = ?, district = ?, postal_code = ?, full_address = ?,
        description = ?, location_description = ?, other_description = ?,
        attributes = ?, equipment = ?,
        price_label = ?, deposit = ?, deposit_text = ?, price_info = ?,
        images = ?, landlord = ?, landlord_type = ?, contact_info = ?,
        last_modified = ?, willhaben_code = ?, heating_info = ?,
        additional_info_urls = ?,
        last_seen_at = ?, is_active = 1,
        job_id = COALESCE(job_id, ?)
        WHERE id = ?`,
      args: [
        listing.title, listing.price, listing.priceText, listing.sizeM2,
        listing.rooms, listing.address, listing.district, listing.postalCode,
        listing.fullAddress,
        listing.description, listing.locationDescription, listing.otherDescription,
        JSON.stringify(listing.attributes), JSON.stringify(listing.equipment),
        listing.priceLabel, listing.deposit, listing.depositText,
        JSON.stringify(listing.priceInfo),
        JSON.stringify(listing.images), listing.landlord, listing.landlordType,
        listing.contactInfo,
        listing.lastModified, listing.willhabenCode, listing.heatingInfo,
        JSON.stringify(listing.additionalInfoUrls),
        now, jobId, listing.id,
      ],
    });
    return false;
  }

  await db.execute({
    sql: `INSERT INTO listings (
      id, url, title, price, price_text, size_m2, rooms,
      address, district, postal_code, full_address,
      description, location_description, other_description,
      attributes, equipment,
      price_label, deposit, deposit_text, price_info,
      images, landlord, landlord_type, contact_info,
      last_modified, willhaben_code, heating_info,
      additional_info_urls, job_id,
      first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      listing.id, listing.url, listing.title, listing.price, listing.priceText,
      listing.sizeM2, listing.rooms, listing.address, listing.district,
      listing.postalCode, listing.fullAddress,
      listing.description, listing.locationDescription, listing.otherDescription,
      JSON.stringify(listing.attributes), JSON.stringify(listing.equipment),
      listing.priceLabel, listing.deposit, listing.depositText,
      JSON.stringify(listing.priceInfo),
      JSON.stringify(listing.images), listing.landlord, listing.landlordType,
      listing.contactInfo,
      listing.lastModified, listing.willhabenCode, listing.heatingInfo,
      JSON.stringify(listing.additionalInfoUrls), jobId,
      now, now,
    ],
  });
  return true;
}

/**
 * Deactivate listings belonging to `jobId` that were not seen in this run.
 * MUST stay scoped to the job — unscoped, each job would deactivate every other
 * job's listings on every run.
 */
export async function markInactiveExcept(activeIds: string[], jobId: string) {
  if (activeIds.length === 0) return;
  const db = getDb();
  const placeholders = activeIds.map(() => "?").join(",");
  await db.execute({
    sql: `UPDATE listings SET is_active = 0
      WHERE is_active = 1 AND job_id = ? AND id NOT IN (${placeholders})`,
    args: [jobId, ...activeIds],
  });
}

export async function getActiveListings(jobId?: string) {
  const db = getDb();
  if (jobId) {
    const result = await db.execute({
      sql: "SELECT * FROM listings WHERE is_active = 1 AND job_id = ? ORDER BY first_seen_at DESC",
      args: [jobId],
    });
    return result.rows;
  }
  const result = await db.execute(
    "SELECT * FROM listings WHERE is_active = 1 ORDER BY first_seen_at DESC"
  );
  return result.rows;
}

export async function getListingById(id: string) {
  const db = getDb();
  const result = await db.execute({ sql: "SELECT * FROM listings WHERE id = ?", args: [id] });
  return result.rows[0] ?? null;
}

export async function getNewListingsSince(since: string) {
  const db = getDb();
  const result = await db.execute({
    sql: "SELECT * FROM listings WHERE first_seen_at >= ? ORDER BY first_seen_at DESC",
    args: [since],
  });
  return result.rows;
}

export async function getScrapedListingIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  const result = await db.execute({
    sql: `SELECT id FROM listings WHERE id IN (${placeholders}) AND attributes IS NOT NULL`,
    args: ids,
  });
  return new Set(result.rows.map((r) => String(r.id)));
}

/**
 * Listings for one job that have not been scored under the given criteria.
 * Scoped to the job so a job never spends tokens scoring another city's
 * listings against its own criteria.
 */
export async function getUnmatchedListings(criteriaHash: string, jobId: string) {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT * FROM listings
     WHERE is_active = 1 AND attributes IS NOT NULL AND job_id = ?
       AND id NOT IN (SELECT listing_id FROM matches WHERE criteria_hash = ?)
     ORDER BY first_seen_at DESC`,
    args: [jobId, criteriaHash],
  });
  return result.rows;
}

// ─── Matches ───────────────────────────────────────────────────────────────

export async function insertMatch(
  listingId: string,
  criteriaHash: string,
  score: number,
  reasoning: string
) {
  const db = getDb();
  await db.execute({
    sql: `INSERT OR IGNORE INTO matches (listing_id, criteria_hash, score, reasoning)
      VALUES (?, ?, ?, ?)`,
    args: [listingId, criteriaHash, score, reasoning],
  });
}

export async function getUnnotifiedMatches() {
  const db = getDb();
  const result = await db.execute(
    `SELECT m.*, l.title, l.url, l.price, l.price_text, l.size_m2, l.rooms, l.address, l.district, l.job_id
     FROM matches m JOIN listings l ON m.listing_id = l.id
     WHERE m.notified = 0 AND m.score >= 60
     ORDER BY l.job_id, m.score DESC`
  );
  return result.rows;
}

export async function markMatchesNotified(matchIds: number[]) {
  if (matchIds.length === 0) return;
  const db = getDb();
  const placeholders = matchIds.map(() => "?").join(",");
  await db.execute({
    sql: `UPDATE matches SET notified = 1 WHERE id IN (${placeholders})`,
    args: matchIds,
  });
}

export async function getMatchesForListing(listingId: string) {
  const db = getDb();
  const result = await db.execute({
    sql: "SELECT * FROM matches WHERE listing_id = ? ORDER BY matched_at DESC",
    args: [listingId],
  });
  return result.rows;
}

// ─── LLM Calls ───────────────────────────────────────────────────────────

export interface LlmCallRecord {
  runId: number | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  listingsCount: number;
  request: string;
  response: string;
}

export async function insertLlmCall(call: LlmCallRecord): Promise<number> {
  const db = getDb();
  const result = await db.execute({
    sql: `INSERT INTO llm_calls (run_id, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, listings_count, request, response)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      call.runId, call.model, call.promptTokens, call.completionTokens,
      call.totalTokens, call.costUsd, call.listingsCount,
      call.request, call.response,
    ],
  });
  return Number(result.lastInsertRowid);
}

export async function getLlmCallsForRun(runId: number) {
  const db = getDb();
  const result = await db.execute({
    sql: "SELECT * FROM llm_calls WHERE run_id = ? ORDER BY id",
    args: [runId],
  });
  return result.rows;
}

export async function getTotalLlmCost() {
  const db = getDb();
  const result = await db.execute(
    "SELECT SUM(cost_usd) as total_cost, SUM(total_tokens) as total_tokens, COUNT(*) as call_count FROM llm_calls"
  );
  return result.rows[0];
}

// ─── Runs ──────────────────────────────────────────────────────────────────

export async function createRun(jobId: string): Promise<number> {
  const db = getDb();
  const result = await db.execute({
    sql: "INSERT INTO runs (started_at, job_id) VALUES (?, ?)",
    args: [new Date().toISOString(), jobId],
  });
  return Number(result.lastInsertRowid);
}

export async function finishRun(
  runId: number,
  stats: { listingsFound: number; newListings: number; matchesFound: number },
  status: "completed" | "cancelled" | "error" = "completed",
  error?: string
) {
  const db = getDb();
  await db.execute({
    sql: `UPDATE runs SET finished_at = ?, listings_found = ?, new_listings = ?,
      matches_found = ?, status = ?, error = ? WHERE id = ?`,
    args: [
      new Date().toISOString(),
      stats.listingsFound,
      stats.newListings,
      stats.matchesFound,
      status,
      error ?? null,
      runId,
    ],
  });
}

export async function getRecentRuns(limit = 10, jobId?: string) {
  const db = getDb();
  if (jobId) {
    const result = await db.execute({
      sql: "SELECT * FROM runs WHERE job_id = ? ORDER BY id DESC LIMIT ?",
      args: [jobId, limit],
    });
    return result.rows;
  }
  const result = await db.execute({
    sql: "SELECT * FROM runs ORDER BY id DESC LIMIT ?",
    args: [limit],
  });
  return result.rows;
}
