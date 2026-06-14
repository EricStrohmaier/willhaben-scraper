import * as cheerio from "cheerio";
import { createPage, acceptCookies } from "../../lib/browser.js";
import { withAbort, delay } from "../../lib/abort.js";
import type { WillhabenListing, WillhabenListingPreview } from "./types.js";

export async function scrapeDetailPage(
  preview: WillhabenListingPreview,
  signal?: AbortSignal
): Promise<WillhabenListing> {
  if (signal?.aborted) throw new Error("Aborted");

  console.log(`[willhaben:detail] Scraping: ${preview.url}`);
  const page = await createPage();

  try {
    return await withAbort(async () => {
      await page.goto(preview.url, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await page.waitForNetworkIdle({ timeout: 10_000 }).catch(() => {});

      await acceptCookies(page);

      const html = await page.content();
      const $ = cheerio.load(html);

      return parseDetailPage($, preview);
    }, signal);
  } finally {
    await page.close().catch(() => {});
  }
}

export async function scrapeDetails(
  previews: WillhabenListingPreview[],
  opts?: { concurrency?: number; signal?: AbortSignal; delayMs?: number }
): Promise<WillhabenListing[]> {
  const concurrency = opts?.concurrency ?? 1;
  const delayMs = opts?.delayMs ?? 2000;
  const results: WillhabenListing[] = [];

  for (let i = 0; i < previews.length; i += concurrency) {
    if (opts?.signal?.aborted) break;

    const batch = previews.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map((p) => scrapeDetailPage(p, opts?.signal))
    );

    for (const r of batchResults) {
      if (r.status === "fulfilled") {
        results.push(r.value);
      } else {
        console.error(`[willhaben:detail] Failed: ${r.reason}`);
      }
    }

    console.log(
      `[willhaben:detail] Progress: ${Math.min(i + concurrency, previews.length)}/${previews.length}`
    );

    if (i + concurrency < previews.length && delayMs > 0) {
      await delay(delayMs, opts?.signal);
    }
  }

  return results;
}

function parseDetailPage(
  $: cheerio.CheerioAPI,
  preview: WillhabenListingPreview
): WillhabenListing {
  const title =
    $('[data-testid="ad-detail-header"]').first().text().trim() ||
    preview.title;

  const fullAddress =
    $('[data-testid="object-location-address"]').first().text().trim() || null;
  const { address, district, postalCode } = parseAddress(
    fullAddress ?? preview.address
  );

  const priceValueEl = $(
    '[data-testid="contact-box-price-box-price-value-0"]'
  ).first();
  const priceText = priceValueEl.text().trim() || preview.priceText;
  const price = priceText ? parsePrice(priceText) : preview.price;
  const priceLabel =
    $('[data-testid="contact-box-price-box-price-label-0"]')
      .first()
      .text()
      .trim() || null;

  const depositText =
    $('[data-testid="contact-box-price-box-additional-price-value-0"]')
      .first()
      .text()
      .trim() || null;
  const deposit = depositText ? parsePrice(depositText) : null;

  const lastModified =
    $('[data-testid="ad-detail-ad-edit-date-top"]').first().text().trim() ||
    null;
  const willhabenCodeEl = $('[data-testid="ad-detail-ad-wh-code-top"]')
    .first()
    .text()
    .trim();
  const willhabenCode =
    willhabenCodeEl?.replace("willhaben-Code: ", "") || preview.id;

  const teaserEl = $('[data-testid="ad-detail-teaser-attribute"]').first();
  let sizeM2 = preview.sizeM2;
  let rooms = preview.rooms;
  teaserEl.find('[data-testid^="ad-detail-teaser-attribute-"]').each((_, el) => {
    const text = $(el).text().trim();
    const sizeMatch = text.match(/^(\d+(?:[.,]\d+)?)\s*m²$/);
    if (sizeMatch) {
      sizeM2 = parseFloat(sizeMatch[1].replace(",", "."));
      return;
    }
    const roomsMatch = text.match(/^(\d+(?:[.,]\d+)?)\s*Zimmer$/);
    if (roomsMatch) {
      rooms = parseFloat(roomsMatch[1].replace(",", "."));
    }
  });

  const attributes = parseAttributeGroups($, "Objektinformationen");
  const equipment = parseAttributeGroups($, "Ausstattung und Freiflächen");

  const description = htmlToText(
    $,
    '[data-testid="ad-description-Objektbeschreibung"]'
  );
  const locationDescription = htmlToText(
    $,
    '[data-testid="ad-description-Lage"]'
  );
  const otherDescription = htmlToText(
    $,
    '[data-testid="ad-description-Sonstiges"]'
  );

  const priceInfo: Record<string, string> = {};
  $('[data-testid^="price-information-freetext-attribute-label-"]').each(
    (_, el) => {
      const label = $(el).text().trim().replace(/:\s*$/, "");
      const idx = ($(el).attr("data-testid") ?? "").replace(
        "price-information-freetext-attribute-label-",
        ""
      );
      const value = $(
        `[data-testid="price-information-freetext-attribute-value-${idx}"]`
      )
        .first()
        .text()
        .trim();
      if (label && value) priceInfo[label] = value;
    }
  );

  const images = parseImages($);

  const landlord =
    $('[data-testid="top-contact-box-seller-name"]').first().text().trim() ||
    null;

  let landlordType: string | null = null;
  if ($('[data-testid="ad-detail-contact-box-dealer-top"]').length) {
    landlordType = "Unternehmen";
  } else if ($('[data-testid="ad-detail-contact-box-private-top"]').length) {
    landlordType = "Privatperson";
  }

  const contactParts: string[] = [];
  $('[data-testid^="contact-box-dealer-top-"]').each((_, el) => {
    const label = $(el).find('[class*="jBVqEu"]').first().text().trim();
    const value = $(el).text().trim();
    if (value) contactParts.push(value);
  });
  const userSince =
    $('[data-testid="top-contact-box-user-since"]').first().text().trim() ||
    null;
  if (userSince) contactParts.push(userSince);

  const sellerWebsite = $(
    '[data-testid^="contact-box-dealer-top-Infos"] a[href]'
  )
    .first()
    .attr("href");
  if (sellerWebsite) contactParts.push(sellerWebsite);

  const contactInfo = contactParts.length > 0 ? contactParts.join(" | ") : null;

  const heatingInfo =
    $('[data-testid*="energy-pass-attribute-value"]').first().text().trim() ||
    null;

  const additionalInfoUrls: string[] = [];
  $('[data-testid="object-infos-url"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) additionalInfoUrls.push(href);
  });

  return {
    id: preview.id,
    url: preview.url,
    title,
    price,
    priceText,
    sizeM2,
    rooms,
    address: address ?? preview.address,
    district: district ?? preview.district,
    imageUrl: preview.imageUrl,
    postalCode,
    fullAddress,
    description,
    locationDescription,
    otherDescription,
    attributes,
    equipment,
    priceLabel,
    deposit,
    depositText,
    priceInfo,
    images,
    landlord,
    landlordType,
    contactInfo,
    lastModified,
    willhabenCode,
    heatingInfo,
    additionalInfoUrls,
  };
}

function parseAttributeGroups(
  $: cheerio.CheerioAPI,
  sectionTitle: string
): Record<string, string> {
  const result: Record<string, string> = {};

  $("h2").each((_, h2) => {
    if ($(h2).text().trim() !== sectionTitle) return;

    const group = $(h2).nextAll('[data-testid="attribute-group"]').first();
    const section = group.length ? group : $(h2).parent();
    section.find('[data-testid="attribute-item"]').each((_, item) => {
      const titleEl = $(item).find('[data-testid="attribute-title"]').first();
      const valueEl = $(item).find('[data-testid="attribute-value"]').first();

      const label = titleEl.text().trim();
      if (!label) return;

      const hasSvg = valueEl.find("svg").length > 0;
      const textValue = valueEl.text().trim();

      if (hasSvg && !textValue) {
        result[label] = "Ja";
      } else if (textValue) {
        result[label] = textValue;
      }
    });
  });

  return result;
}

function parseImages($: cheerio.CheerioAPI): string[] {
  const images: string[] = [];
  const seen = new Set<string>();

  $('[data-testid^="image-"]').each((_, el) => {
    const $el = $(el);
    if ($el.prop("tagName")?.toLowerCase() !== "img") return;

    const src =
      $el.attr("src") ??
      $el.attr("data-flickity-lazyload") ??
      null;
    if (!src || seen.has(src)) return;

    if (src.includes("_thumb.")) return;

    seen.add(src);
    images.push(src);
  });

  return images;
}

function htmlToText($: cheerio.CheerioAPI, selector: string): string | null {
  const el = $(selector).first();
  if (!el.length) return null;

  let html = el.html() ?? "";
  html = html.replace(/<br\s*\/?>/gi, "\n");
  html = html.replace(/<\/p>\s*<p[^>]*>/gi, "\n\n");
  html = html.replace(/<li[^>]*>/gi, "\n- ");
  html = html.replace(/<\/li>/gi, "");
  html = html.replace(/<strong>(.*?)<\/strong>/gi, "$1");
  html = html.replace(/<[^>]+>/g, "");

  const text = html
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text || null;
}

function parseAddress(raw: string | null): {
  address: string | null;
  district: string | null;
  postalCode: string | null;
} {
  if (!raw) return { address: null, district: null, postalCode: null };

  const postalMatch = raw.match(/(\d{4})/);
  const postalCode = postalMatch ? postalMatch[1] : null;

  const parts = raw.split(",").map((p) => p.trim());
  let district: string | null = null;
  if (parts.length > 2) {
    district = parts[parts.length - 2];
  } else if (parts.length === 2) {
    const afterPostal = parts[1];
    if (!/^\d{4}/.test(parts[0]) && afterPostal) {
      district = afterPostal;
    }
  }

  return { address: raw, district, postalCode };
}

function parsePrice(text: string): number | null {
  const cleaned = text
    .replace(/[€\s]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}
