import * as cheerio from "cheerio";
import type { Page } from "puppeteer";
import { createPage, acceptCookies } from "../../lib/browser.js";
import type { WillhabenListingPreview } from "./types.js";

async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
}

export async function scrapeListPage(
  url: string,
  signal?: AbortSignal
): Promise<{ listings: WillhabenListingPreview[]; nextPageUrl: string | null }> {
  if (signal?.aborted) throw new Error("Aborted");

  console.log(`[willhaben:list] Scraping: ${url}`);
  const page = await createPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForNetworkIdle({ timeout: 10_000 }).catch(() => {});

    await acceptCookies(page);

    await page
      .waitForSelector("#skip-to-resultlist", { timeout: 10_000 })
      .catch(() => {});

    await autoScroll(page);
    await page.waitForNetworkIdle({ timeout: 5_000 }).catch(() => {});

    const html = await page.content();
    const $ = cheerio.load(html);

    const listings = parseListings($);
    const nextPageUrl = parseNextPage($);

    console.log(
      `[willhaben:list] Found ${listings.length} listings, next page: ${nextPageUrl ? "yes" : "no"}`
    );

    return { listings, nextPageUrl };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function scrapeAllListPages(
  startUrl: string,
  opts?: {
    maxPages?: number;
    signal?: AbortSignal;
    onBatch?: (batch: WillhabenListingPreview[]) => Promise<void>;
    batchSize?: number;
  }
): Promise<WillhabenListingPreview[]> {
  const maxPages = opts?.maxPages ?? 10;
  const batchSize = opts?.batchSize ?? 25;
  const all: WillhabenListingPreview[] = [];
  const seen = new Set<string>();
  let url: string | null = startUrl;
  let pageNum = 0;
  let unsaved: WillhabenListingPreview[] = [];

  while (url && pageNum < maxPages) {
    if (opts?.signal?.aborted) break;
    pageNum++;

    const { listings, nextPageUrl } = await scrapeListPage(url, opts?.signal);

    if (listings.length === 0) break;

    for (const listing of listings) {
      if (!seen.has(listing.id)) {
        seen.add(listing.id);
        all.push(listing);
        unsaved.push(listing);

        if (opts?.onBatch && unsaved.length >= batchSize) {
          console.log(
            `[willhaben:list] Saving batch of ${unsaved.length} previews to DB...`
          );
          await opts.onBatch(unsaved);
          unsaved = [];
        }
      }
    }

    url = nextPageUrl;

    if (url) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  if (opts?.onBatch && unsaved.length > 0) {
    console.log(
      `[willhaben:list] Saving final batch of ${unsaved.length} previews to DB...`
    );
    await opts.onBatch(unsaved);
  }

  console.log(
    `[willhaben:list] Total: ${all.length} listings across ${pageNum} pages`
  );
  return all;
}

function parseListings($: cheerio.CheerioAPI): WillhabenListingPreview[] {
  const listings: WillhabenListingPreview[] = [];

  // Each result card has an anchor with data-testid="search-result-entry-header-{id}"
  $('a[data-testid^="search-result-entry-header-"]').each((_, el) => {
    const $el = $(el);

    const testId = $el.attr("data-testid") ?? "";
    const id = testId.replace("search-result-entry-header-", "");
    if (!id || !/^\d+$/.test(id)) return;

    const href = $el.attr("href") ?? "";
    const fullUrl = href.startsWith("http")
      ? href
      : `https://www.willhaben.at${href}`;

    const title = $el.find("h3").first().text().trim() || "";

    // Address: span with aria-label starting with "Ort "
    const addressSpan = $el.find('span[aria-label^="Ort "]').first();
    const address = addressSpan.text().trim() || null;
    const postalCode = address?.match(/^(\d{4})/)?.[1] ?? null;

    // Teaser attributes: m², Zimmer, features (Balkon, Terrasse, etc.)
    const teaserSel = `[data-testid="search-result-entry-teaser-attributes-${id}"]`;
    const teaserContainer = $el.find(teaserSel).first();

    let sizeM2: number | null = null;
    let rooms: number | null = null;
    const features: string[] = [];

    teaserContainer.children().each((_, child) => {
      const text = $(child).text().trim();
      const sizeMatch = text.match(/^(\d+(?:[.,]\d+)?)\s*m²$/);
      if (sizeMatch) {
        sizeM2 = parseFloat(sizeMatch[1].replace(",", "."));
        return;
      }
      const roomsMatch = text.match(/^(\d+(?:[.,]\d+)?)\s*Zimmer$/);
      if (roomsMatch) {
        rooms = parseFloat(roomsMatch[1].replace(",", "."));
        return;
      }
      if (text && !sizeMatch && !roomsMatch) {
        features.push(text);
      }
    });

    // Price
    const priceSel = `[data-testid="search-result-entry-price-${id}"]`;
    const priceText = $el.find(priceSel).first().text().trim() || null;
    const price = priceText ? parsePrice(priceText) : null;

    // Seller
    const sellerSel = `[data-testid="search-result-entry-seller-information-${id}"]`;
    const seller = $el.find(sellerSel).first().text().trim() || null;

    // Cover image
    const imageUrl =
      $el.find('img[alt="Cover Image"]').first().attr("src") ?? null;

    // District: try to extract from address (e.g. "6020 Innsbruck, Wilten")
    let district: string | null = null;
    if (address) {
      const parts = address.split(",").map((s) => s.trim());
      if (parts.length > 1) {
        district = parts.slice(1).join(", ");
      }
    }

    listings.push({
      id,
      url: fullUrl,
      title,
      price,
      priceText,
      sizeM2,
      rooms,
      address,
      district,
      imageUrl,
    });
  });

  return listings;
}

function parseNextPage($: cheerio.CheerioAPI): string | null {
  const nextBtn = $(
    'a[data-testid="pagination-bottom-next-button"]'
  ).first();

  if (nextBtn.attr("disabled") !== undefined || nextBtn.attr("aria-disabled") === "true") {
    return null;
  }

  const href = nextBtn.attr("href");
  if (!href) return null;

  return href.startsWith("http")
    ? href
    : `https://www.willhaben.at${href}`;
}

function parsePrice(text: string): number | null {
  const cleaned = text.replace(/[€\s]/g, "").replace(/\./g, "").replace(",", ".");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}
