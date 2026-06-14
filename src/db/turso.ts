import { createClient, type Client } from "@libsql/client";

let client: Client | null = null;

export function hasTurso(): boolean {
  return !!(process.env.TURSO_DATABASE_URL || process.env.LOCAL_DB_PATH);
}

export function getDb(): Client {
  if (client) return client;

  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const localPath = process.env.LOCAL_DB_PATH;

  if (tursoUrl) {
    client = createClient({
      url: tursoUrl,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  } else if (localPath) {
    client = createClient({ url: `file:${localPath}` });
  } else {
    client = createClient({ url: "file:data/scraping.db" });
  }

  return client;
}
