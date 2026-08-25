import { getDb } from "./turso.js";
import { getEnabledJobs } from "../config/jobs.js";

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    title TEXT,
    price REAL,
    price_text TEXT,
    size_m2 REAL,
    rooms REAL,
    address TEXT,
    district TEXT,
    postal_code TEXT,
    description TEXT,
    attributes TEXT,
    images TEXT,
    landlord TEXT,
    contact_info TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    is_active INTEGER DEFAULT 1
  )`,

  `CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id TEXT NOT NULL REFERENCES listings(id),
    criteria_hash TEXT,
    score REAL,
    reasoning TEXT,
    matched_at TEXT DEFAULT (datetime('now')),
    notified INTEGER DEFAULT 0,
    UNIQUE(listing_id, criteria_hash)
  )`,

  `CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    listings_found INTEGER DEFAULT 0,
    new_listings INTEGER DEFAULT 0,
    matches_found INTEGER DEFAULT 0,
    status TEXT DEFAULT 'running',
    error TEXT
  )`,

  `CREATE INDEX IF NOT EXISTS idx_listings_active ON listings(is_active)`,
  `CREATE INDEX IF NOT EXISTS idx_matches_listing ON matches(listing_id)`,
  `CREATE INDEX IF NOT EXISTS idx_matches_notified ON matches(notified)`,

  `CREATE TABLE IF NOT EXISTS llm_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER REFERENCES runs(id),
    model TEXT NOT NULL,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    cost_usd REAL,
    listings_count INTEGER,
    request TEXT NOT NULL,
    response TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_llm_calls_run ON llm_calls(run_id)`,
];

const ALTER_COLUMNS = [
  { table: "listings", column: "full_address", type: "TEXT" },
  { table: "listings", column: "location_description", type: "TEXT" },
  { table: "listings", column: "other_description", type: "TEXT" },
  { table: "listings", column: "equipment", type: "TEXT" },
  { table: "listings", column: "price_label", type: "TEXT" },
  { table: "listings", column: "deposit", type: "REAL" },
  { table: "listings", column: "deposit_text", type: "TEXT" },
  { table: "listings", column: "price_info", type: "TEXT" },
  { table: "listings", column: "landlord_type", type: "TEXT" },
  { table: "listings", column: "last_modified", type: "TEXT" },
  { table: "listings", column: "willhaben_code", type: "TEXT" },
  { table: "listings", column: "heating_info", type: "TEXT" },
  { table: "listings", column: "additional_info_urls", type: "TEXT" },
  // Multi-job support: every listing and run belongs to exactly one search job.
  { table: "listings", column: "job_id", type: "TEXT" },
  { table: "runs", column: "job_id", type: "TEXT" },
];

const POST_MIGRATIONS = [
  `CREATE INDEX IF NOT EXISTS idx_listings_job ON listings(job_id)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_id)`,
];

export async function migrate() {
  const db = getDb();

  for (const sql of MIGRATIONS) {
    await db.execute(sql);
  }

  for (const { table, column, type } of ALTER_COLUMNS) {
    await db
      .execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
      .catch(() => {});
  }

  for (const sql of POST_MIGRATIONS) {
    await db.execute(sql);
  }

  await backfillJobId(db);

  console.log("[db] Migrations applied");
}

/**
 * Rows created before multi-job support have job_id = NULL. Left alone they'd
 * never match a job-scoped query, so they would stay active forever and never
 * be re-matched. Attribute them to the first enabled job (override with
 * LEGACY_JOB_ID). Idempotent: a fresh database has no NULL rows to touch.
 */
async function backfillJobId(db: ReturnType<typeof getDb>) {
  const legacyJobId = process.env.LEGACY_JOB_ID || getEnabledJobs()[0]?.id;
  if (!legacyJobId) return;

  for (const table of ["listings", "runs"]) {
    const result = await db.execute({
      sql: `UPDATE ${table} SET job_id = ? WHERE job_id IS NULL`,
      args: [legacyJobId],
    });
    if (result.rowsAffected > 0) {
      console.log(
        `[db] Backfilled ${result.rowsAffected} ${table} row(s) to job "${legacyJobId}"`
      );
    }
  }
}

const isDirectRun =
  process.argv[1]?.endsWith("migrate.ts") ||
  process.argv[1]?.endsWith("migrate.js");
if (isDirectRun) {
  migrate()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
