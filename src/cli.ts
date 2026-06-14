import "dotenv/config";
import { runPipeline } from "./pipeline.js";
import { migrate } from "./db/migrate.js";
import { getActiveListings, getRecentRuns, getTotalLlmCost, getLlmCallsForRun } from "./db/queries.js";
import { getUnnotifiedMatches } from "./db/queries.js";
import { closeLocalBrowser } from "./lib/browser.js";
import { SEARCH_URLS } from "./config/urls.js";

async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);

  switch (command) {
    case "scrape":
    case "run": {
      const urls = args.filter((a) => !a.startsWith("--"));
      const searchUrls = urls.length > 0 ? urls : SEARCH_URLS;
      const maxPages = parseInt(
        args.find((a) => a.startsWith("--pages="))?.split("=")[1] ?? "10",
        10
      );
      const skipMatch = args.includes("--no-match");
      const skipNotify = args.includes("--no-notify");

      const ac = new AbortController();
      let aborting = false;

      // Keep event loop alive during cleanup so finishRun can complete
      let keepAlive: ReturnType<typeof setInterval> | null = null;

      // Suppress unhandled rejections from Puppeteer when browser dies on SIGINT
      process.on("unhandledRejection", (reason) => {
        if (aborting) return;
        console.error("[cli] Unhandled rejection:", reason);
      });

      const onSignal = () => {
        if (aborting) {
          console.log("\n[cli] Force exit");
          process.exit(1);
        }
        aborting = true;
        console.log(
          "\n[cli] Cancelling... waiting for DB cleanup (press again to force exit)"
        );
        ac.abort();
        keepAlive = setInterval(() => {}, 1000);
      };
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);

      for (const url of searchUrls) {
        if (ac.signal.aborted) break;
        console.log(`Running pipeline: ${url} (max ${maxPages} pages)`);
        const result = await runPipeline({
          url,
          maxPages,
          signal: ac.signal,
          skipMatch: command === "scrape" || skipMatch,
          skipNotify,
        });
        console.log("\nResult:", JSON.stringify(result, null, 2));
      }

      if (keepAlive) clearInterval(keepAlive);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      break;
    }

    case "listings": {
      await migrate();
      const listings = await getActiveListings();
      console.log(`\nActive listings: ${listings.length}\n`);
      for (const l of listings) {
        console.log(
          `  ${l.id} | €${l.price ?? "?"} | ${l.size_m2 ?? "?"}m² | ${l.rooms ?? "?"} Zi | ${l.title}`
        );
        console.log(`    ${l.url}`);
      }
      break;
    }

    case "matches": {
      await migrate();
      const matches = await getUnnotifiedMatches();
      console.log(`\nUnnotified matches: ${matches.length}\n`);
      for (const m of matches) {
        console.log(`  Score: ${m.score}/100 | ${m.title}`);
        console.log(`    ${m.reasoning}`);
        console.log(`    ${m.url}\n`);
      }
      break;
    }

    case "runs": {
      await migrate();
      const runs = await getRecentRuns();
      console.log(`\nRecent runs:\n`);
      for (const r of runs) {
        console.log(
          `  #${r.id} | ${r.status} | ${r.listings_found} found | ${r.new_listings} new | ${r.matches_found} matches | ${r.started_at}`
        );
      }
      break;
    }

    case "costs": {
      await migrate();
      const totals = await getTotalLlmCost();
      console.log(`\nLLM API Usage:`);
      console.log(`  Total calls: ${totals.call_count}`);
      console.log(`  Total tokens: ${totals.total_tokens ?? 0}`);
      console.log(`  Total cost: $${Number(totals.total_cost ?? 0).toFixed(4)}`);

      const runIdArg = args[0];
      if (runIdArg) {
        const calls = await getLlmCallsForRun(parseInt(runIdArg, 10));
        console.log(`\n  Calls for run #${runIdArg}:`);
        for (const c of calls) {
          console.log(
            `    #${c.id} | ${c.model} | ${c.listings_count} listings | ${c.total_tokens} tokens | $${Number(c.cost_usd).toFixed(4)}`
          );
        }
      }
      break;
    }

    case "migrate": {
      await migrate();
      console.log("Done.");
      break;
    }

    default:
      console.log(`
Usage: tsx src/cli.ts <command> [options]

Commands:
  scrape [url...]       Scrape listings only (no matching)
  run [url...]          Full pipeline: scrape + match + notify
  listings              Show active listings in DB
  matches               Show unnotified matches
  runs                  Show recent pipeline runs
  costs [runId]         Show LLM API usage and costs
  migrate               Run database migrations

Options:
  --pages=N             Max pages to scrape (default: 10)
  --no-match            Skip OpenAI matching
  --no-notify           Skip notifications

Default URLs (from config/urls.ts):
${SEARCH_URLS.map((u) => "  " + u).join("\n")}
      `);
  }

  await closeLocalBrowser().catch(() => {});
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await closeLocalBrowser().catch(() => {});
  process.exit(1);
});
