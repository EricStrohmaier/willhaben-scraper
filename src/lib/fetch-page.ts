import {
  createPage,
  connectRemoteBrowser,
  hasRemoteBrowser,
} from "./browser.js";

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export async function fetchPage(
  url: string,
  opts?: {
    timeout?: number;
    render?: boolean;
    useRemote?: boolean;
    waitForSelector?: string;
  }
): Promise<string | null> {
  const timeout = opts?.timeout ?? 30_000;
  const canUseRemote = opts?.useRemote && hasRemoteBrowser();

  // ── Tier 1: got-scraping (free, ~100ms) ──
  if (!opts?.render) {
    try {
      const { gotScraping } = await import("got-scraping");
      const response = await gotScraping({
        url,
        headerGeneratorOptions: {
          browsers: [{ name: "chrome", minVersion: 128 }],
          operatingSystems: ["macos"],
          locales: ["de-AT"],
        },
        timeout: { request: Math.min(timeout, 20_000) },
        followRedirect: true,
        throwHttpErrors: false,
      });

      if (response.statusCode === 200 && response.body) {
        if (looksLikeRealPage(response.body)) {
          console.log(
            `[fetch-page] got-scraping OK for ${hostname(url)} (${response.body.length}b)`
          );
          return response.body;
        }
        console.log(
          `[fetch-page] got-scraping got bot challenge for ${hostname(url)} (${response.body.length}b)`
        );
      } else {
        console.log(
          `[fetch-page] got-scraping ${hostname(url)}: status=${response.statusCode}, ${response.body?.length ?? 0}b`
        );
      }
    } catch (err: unknown) {
      const errDetail =
        err instanceof Error
          ? `${err.message || "(empty message)"} [${err.constructor.name}]`
          : JSON.stringify(err);
      console.log(
        `[fetch-page] got-scraping failed for ${hostname(url)}: ${errDetail}`
      );
    }
  }

  // ── Tier 2: Local Puppeteer (free, ~5-15s) ──
  {
    let page;
    try {
      page = await createPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      await page.waitForNetworkIdle({ timeout: 10_000 }).catch(() => {});

      if (opts?.waitForSelector) {
        await page.waitForSelector(opts.waitForSelector, { timeout: 8_000 }).catch(() => {});
      }

      await autoScroll(page);
      await new Promise((r) => setTimeout(r, 2000));

      const html = await page.content();

      if (html && html.length > 500 && looksLikeRealPage(html)) {
        console.log(
          `[fetch-page] Local Puppeteer OK for ${hostname(url)} (${html.length}b)`
        );
        return html;
      }

      console.log(
        `[fetch-page] Local Puppeteer got ${html && html.length > 500 ? "bot challenge" : "empty page"} for ${hostname(url)} (${html?.length ?? 0}b)`
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[fetch-page] Local Puppeteer failed for ${hostname(url)}: ${errMsg}`
      );
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  // ── Tier 3: Remote Scraping Browser (paid, on-demand) ──
  if (canUseRemote) {
    let remoteBrowser;
    try {
      remoteBrowser = await connectRemoteBrowser();
      if (remoteBrowser) {
        const page = await remoteBrowser.newPage();

        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForNetworkIdle({ timeout: 15_000 }).catch(() => {});

        await autoScroll(page);
        await new Promise((r) => setTimeout(r, 2000));

        const html = await page.content();

        if (html && html.length > 500 && looksLikeRealPage(html)) {
          console.log(
            `[fetch-page] Remote browser OK for ${hostname(url)} (${html.length}b)`
          );
          return html;
        }
        console.log(
          `[fetch-page] Remote browser got ${html && html.length > 500 ? "bot challenge" : "empty page"} for ${hostname(url)} (${html?.length ?? 0}b)`
        );
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[fetch-page] Remote browser failed for ${hostname(url)}: ${errMsg}`
      );
    } finally {
      if (remoteBrowser) await remoteBrowser.close().catch(() => {});
    }
  }

  console.warn(`[fetch-page] All strategies failed for ${url}`);
  return null;
}

async function autoScroll(page: import("puppeteer").Page) {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let totalHeight = 0;
      const distance = 400;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight || totalHeight >= 8000) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
    });
  });
}

function looksLikeRealPage(html: string): boolean {
  if (html.length < 1000) return false;
  if (/<title[^>]*>Just a moment/i.test(html)) return false;

  const hasRealContent =
    html.includes("application/ld+json") ||
    html.includes("__NEXT_DATA__") ||
    html.includes("<article") ||
    html.includes("<main");

  if (hasRealContent) return true;

  const challengeStrings = [
    "Performing security verification",
    "Verifying Connection",
    "checking your browser",
    "cf-browser-verification",
    "cf_chl_opt",
  ];
  for (const s of challengeStrings) {
    if (html.includes(s)) return false;
  }

  return html.length > 10_000;
}
