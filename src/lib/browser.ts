import puppeteer, { type Browser, type Page } from "puppeteer";

// ─── Configuration ──────────────────────────────────────────────────────────

const SCRAPING_BROWSER_WS = process.env.SCRAPING_BROWSER_WS || "";

// ─── Local browser (free, shared singleton) ─────────────────────────────────

let localBrowser: Browser | null = null;
let localLaunchPromise: Promise<Browser> | null = null;

export async function getLocalBrowser(): Promise<Browser> {
  if (localBrowser?.connected) return localBrowser;
  if (localLaunchPromise) return localLaunchPromise;

  console.log("[browser] Launching local Chromium...");

  localLaunchPromise = puppeteer.launch({
    headless: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
    ],
  });

  localBrowser = await localLaunchPromise;
  localLaunchPromise = null;

  localBrowser.on("disconnected", () => {
    console.log("[browser] Local browser disconnected, will relaunch on next request");
    localBrowser = null;
  });

  return localBrowser;
}

export async function closeLocalBrowser(): Promise<void> {
  if (localBrowser) {
    await localBrowser.close().catch(() => {});
    localBrowser = null;
  }
}

export async function createPage(): Promise<Page> {
  const browser = await getLocalBrowser();
  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1440, height: 900 });
  await page.setExtraHTTPHeaders({ "Accept-Language": "de-AT,de;q=0.9,en;q=0.8" });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  return page;
}

export async function acceptCookies(page: Page): Promise<void> {
  try {
    await page.waitForSelector(
      '#didomi-notice-agree-button, [aria-label="Annehmen und Schließen: Unsere Datenverarbeitung akzeptieren und schließen"], [data-testid="accept-all-cookies"]',
      { timeout: 5000 }
    );
    for (const selector of [
      "#didomi-notice-agree-button",
      '[aria-label="Annehmen und Schließen: Unsere Datenverarbeitung akzeptieren und schließen"]',
      '[data-testid="accept-all-cookies"]',
    ]) {
      try {
        await page.click(selector);
        console.log("[browser] Accepted cookies");
        return;
      } catch {}
    }
  } catch {
    // No cookie consent found or already accepted
  }
}

// ─── Remote Scraping Browser (paid, per-request) ────────────────────────────

export function hasRemoteBrowser(): boolean {
  return !!SCRAPING_BROWSER_WS;
}

export async function connectRemoteBrowser(): Promise<Browser | null> {
  if (!SCRAPING_BROWSER_WS) return null;

  const endpoint = SCRAPING_BROWSER_WS.replace(/\/+$/, "");
  console.log("[browser] Connecting to remote Scraping Browser (paid)...");
  try {
    const browser = await puppeteer.connect({
      browserWSEndpoint: endpoint,
    });
    console.log("[browser] Remote browser connected");
    return browser;
  } catch (err) {
    console.warn(
      `[browser] Remote browser connection failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}
