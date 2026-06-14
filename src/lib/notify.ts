import { getUnnotifiedMatches, markMatchesNotified } from "../db/queries.js";

export function hasNotification(): boolean {
  return !!(process.env.NOTIFICATION_EMAIL || process.env.NOTIFICATION_WEBHOOK);
}

export interface NotificationPayload {
  title: string;
  body: string;
  matches: Array<{
    title: string;
    url: string;
    price: string;
    score: number;
    reasoning: string;
  }>;
}

/**
 * Check for unnotified matches and send notifications.
 */
export async function sendNewMatchNotifications(): Promise<number> {
  const rows = await getUnnotifiedMatches();
  if (rows.length === 0) {
    console.log("[notify] No new matches to notify about");
    return 0;
  }

  const matches = rows.map((r) => ({
    title: String(r.title ?? ""),
    url: String(r.url ?? ""),
    price: r.price != null ? `€${r.price}` : String(r.price_text ?? ""),
    score: Number(r.score ?? 0),
    reasoning: String(r.reasoning ?? ""),
    size: r.size_m2 != null ? `${r.size_m2} m²` : "",
    rooms: r.rooms != null ? `${r.rooms} Zimmer` : "",
    address: String(r.address ?? ""),
  }));

  const payload: NotificationPayload = {
    title: `🏠 ${matches.length} new apartment match${matches.length > 1 ? "es" : ""} found!`,
    body: matches
      .map(
        (m) =>
          `• ${m.title}\n  ${[m.price, m.size, m.rooms].filter(Boolean).join(" | ")}\n  ${m.address}\n  Score: ${m.score}/100 — ${m.reasoning}\n  ${m.url}`
      )
      .join("\n\n"),
    matches,
  };

  // Send via webhook if configured
  const webhookUrl = process.env.NOTIFICATION_WEBHOOK;
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      console.log(`[notify] Webhook sent: ${matches.length} matches`);
    } catch (err) {
      console.error(`[notify] Webhook failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Log to console (always)
  console.log(`\n${"=".repeat(60)}`);
  console.log(payload.title);
  console.log("=".repeat(60));
  console.log(payload.body);
  console.log("=".repeat(60) + "\n");

  // Mark as notified
  const matchIds = rows.map((r) => Number(r.id));
  await markMatchesNotified(matchIds);

  return matches.length;
}
