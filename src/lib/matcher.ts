import OpenAI from "openai";
import { createHash } from "crypto";
import type { WillhabenListing } from "../scrapers/willhaben/types.js";
import { insertMatch, insertLlmCall } from "../db/queries.js";
import { MATCH_CRITERIA } from "../config/match-criteria.js";

const BATCH_SIZE = 10;

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4o": { input: 2.50, output: 10.00 },
  "gpt-4.1-mini": { input: 0.40, output: 1.60 },
  "gpt-4.1-nano": { input: 0.10, output: 0.40 },
};

let openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (openai) return openai;
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

export function hasOpenAI(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

export function getCriteria(): string {
  return MATCH_CRITERIA;
}

export function getCriteriaHash(): string {
  return createHash("sha256").update(getCriteria()).digest("hex").slice(0, 16);
}

function getModel(): string {
  return process.env.MATCH_MODEL || "gpt-4o-mini";
}

function calculateCost(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (promptTokens * pricing.input + completionTokens * pricing.output) / 1_000_000;
}

export interface MatchResult {
  listingId: string;
  score: number;
  reasoning: string;
}

async function matchBatch(
  listings: WillhabenListing[],
  runId: number | null,
): Promise<MatchResult[]> {
  const client = getOpenAI();
  const criteria = getCriteria();
  const model = getModel();

  const listingsText = listings
    .map((l, i) => `--- Listing ${i + 1} (ID: ${l.id}) ---\n${formatListingForLLM(l)}`)
    .join("\n\n");

  const systemPrompt = `${criteria}

You are scoring ${listings.length} listings. Return a JSON object:
{
  "results": [
    {"id": "<listing_id>", "score": <0-100>, "reasoning": "<brief explanation>"},
    ...
  ]
}
Return one entry per listing, in the same order.`;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: listingsText },
  ];

  const response = await client.chat.completions.create({
    model,
    messages,
    response_format: { type: "json_object" },
    temperature: 0.3,
  });

  const content = response.choices[0]?.message?.content ?? "{}";
  const usage = response.usage;
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  const totalTokens = usage?.total_tokens ?? 0;
  const costUsd = calculateCost(model, promptTokens, completionTokens);

  await insertLlmCall({
    runId,
    model,
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd,
    listingsCount: listings.length,
    request: JSON.stringify(messages),
    response: content,
  });

  console.log(
    `[matcher] API call: ${listings.length} listings, ${totalTokens} tokens, $${costUsd.toFixed(4)}`
  );

  let parsed: { results?: Array<{ id?: string; score?: number; reasoning?: string }> };
  try {
    parsed = JSON.parse(content);
  } catch {
    console.error("[matcher] Failed to parse LLM response");
    return listings.map((l) => ({
      listingId: l.id,
      score: 0,
      reasoning: "Failed to parse LLM response",
    }));
  }

  const resultMap = new Map(
    (parsed.results ?? []).map((r) => [String(r.id), r])
  );

  return listings.map((l) => {
    const r = resultMap.get(l.id);
    return {
      listingId: l.id,
      score: r?.score ?? 0,
      reasoning: r?.reasoning ?? "No result from LLM",
    };
  });
}

export async function matchListings(
  listings: WillhabenListing[],
  opts?: { minScore?: number; signal?: AbortSignal; runId?: number }
): Promise<MatchResult[]> {
  const criteriaHash = getCriteriaHash();
  const results: MatchResult[] = [];
  let totalCost = 0;

  for (let i = 0; i < listings.length; i += BATCH_SIZE) {
    if (opts?.signal?.aborted) break;

    const batch = listings.slice(i, i + BATCH_SIZE);
    console.log(
      `[matcher] Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(listings.length / BATCH_SIZE)}: ${batch.length} listings`
    );

    try {
      const batchResults = await matchBatch(batch, opts?.runId ?? null);

      for (const result of batchResults) {
        results.push(result);
        await insertMatch(
          result.listingId,
          criteriaHash,
          result.score,
          result.reasoning,
        );
        console.log(
          `[matcher] ${result.listingId}: score=${result.score} — ${result.reasoning.slice(0, 80)}`
        );
      }
    } catch (err) {
      console.error(
        `[matcher] Batch failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const minScore = opts?.minScore ?? 60;
  const matches = results.filter((r) => r.score >= minScore);
  console.log(
    `[matcher] ${matches.length}/${results.length} listings scored >= ${minScore}, total cost: $${totalCost.toFixed(4)}`
  );

  return results;
}

function formatListingForLLM(listing: WillhabenListing): string {
  const parts = [
    `Title: ${listing.title}`,
    listing.price != null ? `Price: €${listing.price}/month` : null,
    listing.priceText ? `Price text: ${listing.priceText}` : null,
    listing.sizeM2 != null ? `Size: ${listing.sizeM2} m²` : null,
    listing.rooms != null ? `Rooms: ${listing.rooms}` : null,
    listing.address ? `Address: ${listing.address}` : null,
    listing.district ? `District: ${listing.district}` : null,
    listing.postalCode ? `Postal code: ${listing.postalCode}` : null,
    listing.description ? `Description: ${listing.description}` : null,
    listing.locationDescription ? `Location: ${listing.locationDescription}` : null,
    listing.otherDescription ? `Other: ${listing.otherDescription}` : null,
    listing.landlordType ? `Landlord type: ${listing.landlordType}` : null,
    Object.keys(listing.attributes).length > 0
      ? `Attributes:\n${Object.entries(listing.attributes).map(([k, v]) => `  ${k}: ${v}`).join("\n")}`
      : null,
    `URL: ${listing.url}`,
  ];

  return parts.filter(Boolean).join("\n");
}
