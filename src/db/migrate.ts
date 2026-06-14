import { getDb } from "./turso.js";

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
  { column: "full_address", type: "TEXT" },
  { column: "location_description", type: "TEXT" },
  { column: "other_description", type: "TEXT" },
  { column: "equipment", type: "TEXT" },
  { column: "price_label", type: "TEXT" },
  { column: "deposit", type: "REAL" },
  { column: "deposit_text", type: "TEXT" },
  { column: "price_info", type: "TEXT" },
  { column: "landlord_type", type: "TEXT" },
  { column: "last_modified", type: "TEXT" },
  { column: "willhaben_code", type: "TEXT" },
  { column: "heating_info", type: "TEXT" },
  { column: "additional_info_urls", type: "TEXT" },
];

export async function migrate() {
  const db = getDb();

  for (const sql of MIGRATIONS) {
    await db.execute(sql);
  }

  for (const { column, type } of ALTER_COLUMNS) {
    await db
      .execute(`ALTER TABLE listings ADD COLUMN ${column} ${type}`)
      .catch(() => {});
  }

  console.log("[db] Migrations applied");
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
