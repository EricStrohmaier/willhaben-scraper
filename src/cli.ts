import "dotenv/config";
import { runPipeline } from "./pipeline.js";
import { migrate } from "./db/migrate.js";
import { getActiveListings, getRecentRuns, getTotalLlmCost, getLlmCallsForRun, finishRun } from "./db/queries.js";
import { getUnnotifiedMatches } from "./db/queries.js";
import { closeLocalBrowser } from "./lib/browser.js";
import {
  getEnabledJobs,
  getJob,
  resolveJob,
  JOBS,
  type SearchJob,
} from "./config/jobs.js";

async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);

  switch (command) {
    case "scrape":
    case "run": {
      const urls = args.filter((a) => !a.startsWith("--"));
      const jobFilter = args.find((a) => a.startsWith("--job="))?.split("=")[1];
      const pagesArg = args.find((a) => a.startsWith("--pages="))?.split("=")[1];
      const maxPages = pagesArg ? parseInt(pagesArg, 10) : undefined;

      // Explicit URLs win; otherwise run the configured jobs (optionally filtered).
      let targetJobs: SearchJob[];
      if (urls.length > 0) {
        targetJobs = urls.map((u) => resolveJob(u));
      } else if (jobFilter) {
        const job = getJob(jobFilter);
        if (!job) {
          console.error(
            `Unknown job "${jobFilter}". Available: ${JOBS.map((j) => j.id).join(", ")}`
          );
          process.exit(1);
        }
        targetJobs = [job];
      } else {
        targetJobs = getEnabledJobs();
      }

      if (targetJobs.length === 0) {
        console.error("No enabled jobs to run. Check src/config/jobs.ts");
        process.exit(1);
      }
      const skipMatch = args.includes("--no-match");
      const skipNotify = args.includes("--no-notify");

      const ac = new AbortController();
      let aborting = false;
      let abortedAt = 0;
      let currentRunId: number | null = null;
      let pipelineFinished = false;

      // Keep event loop alive during cleanup so finishRun can complete
      let keepAlive: ReturnType<typeof setInterval> | null = null;

      // Suppress Puppeteer cascading errors when browser dies on SIGINT
      process.on("unhandledRejection", (reason) => {
        if (aborting) return;
        console.error("[cli] Unhandled rejection:", reason);
      });
      process.on("uncaughtException", (err) => {
        if (aborting) return;
        console.error("[cli] Uncaught exception:", err);
        process.exit(1);
      });

      const onSignal = () => {
        if (aborting) {
          if (Date.now() - abortedAt < 1500) return;
          console.log("\n[cli] Force exit");
          process.exit(1);
        }
        aborting = true;
        abortedAt = Date.now();
        console.log(
          "\n[cli] Cancelling... waiting for DB cleanup (press again to force exit)"
        );
        ac.abort();
        closeLocalBrowser().catch(() => {});
        keepAlive = setInterval(() => {}, 1000);

        // Safety: if pipeline doesn't finish in 5s, force DB update and exit
        setTimeout(async () => {
          if (pipelineFinished) return;
          if (currentRunId) {
            console.log(`[cli] Cleanup timed out, forcing DB update for run #${currentRunId}`);
            await finishRun(
              currentRunId,
              { listingsFound: 0, newListings: 0, matchesFound: 0 },
              "cancelled",
              "Cancelled by user (cleanup timeout)"
            ).catch((e) => console.error(`[cli] Failed: ${e}`));
          }
          process.exit(1);
        }, 5000).unref();
      };
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);

      console.log(
        `Running ${targetJobs.length} job(s): ${targetJobs.map((j) => j.id).join(", ")}\n`
      );

      const summary: Array<{ job: string; status: string; found: number; matches: number }> = [];

      for (const job of targetJobs) {
        if (ac.signal.aborted) break;
        pipelineFinished = false;
        console.log(
          `── ${job.name} (${job.id}) ── ${job.urls.length} URL(s)`
        );
        const result = await runPipeline({
          job,
          maxPages,
          signal: ac.signal,
          skipMatch: command === "scrape" || skipMatch,
          skipNotify,
          onRunCreated: (id) => { currentRunId = id; },
        });
        pipelineFinished = true;
        summary.push({
          job: job.id,
          status: result.status,
          found: result.listingsFound,
          matches: result.matchesFound,
        });
        console.log("\nResult:", JSON.stringify(result, null, 2), "\n");
      }

      console.log("\n=== Summary ===");
      for (const s of summary) {
        console.log(
          `  ${s.job.padEnd(12)} ${s.status.padEnd(10)} ${s.found} found, ${s.matches} matches`
        );
      }

      if (keepAlive) clearInterval(keepAlive);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      break;
    }

    case "listings": {
      await migrate();
      const jobFilter = args.find((a) => a.startsWith("--job="))?.split("=")[1];
      const listings = await getActiveListings(jobFilter);
      console.log(
        `\nActive listings${jobFilter ? ` for job "${jobFilter}"` : ""}: ${listings.length}\n`
      );
      for (const l of listings) {
        console.log(
          `  [${String(l.job_id ?? "-").padEnd(10)}] ${l.id} | €${l.price ?? "?"} | ${l.size_m2 ?? "?"}m² | ${l.rooms ?? "?"} Zi | ${l.title}`
        );
        console.log(`    ${l.url}`);
      }
      break;
    }

    case "jobs": {
      console.log(`\nConfigured jobs:\n`);
      for (const j of JOBS) {
        console.log(
          `  ${j.id.padEnd(12)} ${j.enabled ? "enabled " : "disabled"} | cap €${j.softCapEur ?? "none"} | ${j.urls.length} URL(s) | max ${j.maxDetailsPerRun} details/run`
        );
        for (const u of j.urls) console.log(`      ${u}`);
      }
      break;
    }

    case "matches": {
      await migrate();
      const matches = await getUnnotifiedMatches();
      console.log(`\nUnnotified matches: ${matches.length}\n`);
      for (const m of matches) {
        console.log(`  [${m.job_id ?? "-"}] Score: ${m.score}/100 | ${m.title}`);
        console.log(`    ${m.reasoning}`);
        console.log(`    ${m.url}\n`);
      }
      break;
    }

    case "runs": {
      await migrate();
      const jobFilter = args.find((a) => a.startsWith("--job="))?.split("=")[1];
      const runs = await getRecentRuns(10, jobFilter);
      console.log(`\nRecent runs${jobFilter ? ` for job "${jobFilter}"` : ""}:\n`);
      for (const r of runs) {
        console.log(
          `  #${r.id} | ${String(r.job_id ?? "-").padEnd(12)} | ${r.status} | ${r.listings_found} found | ${r.new_listings} new | ${r.matches_found} matches | ${r.started_at}`
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
  jobs                  Show configured search jobs
  listings              Show active listings in DB
  matches               Show unnotified matches
  runs                  Show recent pipeline runs
  costs [runId]         Show LLM API usage and costs
  migrate               Run database migrations

Options:
  --job=<id>            Run/filter a single job instead of all enabled ones
  --pages=N             Override the job's maxPages
  --no-match            Skip OpenAI matching
  --no-notify           Skip notifications

Configured jobs (from config/jobs.ts):
${JOBS.map((j) => `  ${j.id.padEnd(12)} ${j.enabled ? "enabled" : "disabled"}  ${j.urls.length} URL(s)`).join("\n")}
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
