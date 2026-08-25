import { createHash } from "crypto";

export interface SearchJob {
  /** Stable slug. Stored on every listing — changing it orphans existing rows. */
  id: string;
  name: string;
  /** One or more willhaben search URLs. Results are pooled into this one job. */
  urls: string[];
  enabled: boolean;
  /**
   * Soft monthly-rent ceiling in EUR. Listings above it are scored down in
   * proportion to how far over they are, but are never excluded outright.
   * Set to null to drop the budget section from the criteria entirely.
   */
  softCapEur: number | null;
  /** Max search-result pages to walk per URL. Bounds how many previews we collect. */
  maxPages: number;
  /**
   * Max detail pages to fetch per run, across all of this job's URLs. Detail
   * pages cost ~2-4s each, so this is the main guard against a broad search URL
   * blowing the CI timeout. Listings not reached this run are picked up next run.
   */
  maxDetailsPerRun: number;
  /** City-specific location guidance, appended to the shared criteria. */
  locationGuidance: string;
}

/**
 * Requirements that apply to every job, regardless of city.
 * The response format is deliberately NOT specified here — the matcher owns it,
 * because it varies with batch size.
 */
const SHARED_CRITERIA = `
You are evaluating apartment rental listings in Austria for a couple.
Score each listing from 0-100 on how well it matches the criteria below.

Hard requirements — a listing that clearly fails any of these scores below 30:
- Available for long-term rent, at least 1 year.
- Move-in at the beginning of October. Nothing else fits.
- At least 2 rooms (one bedroom plus one living room). More rooms is fine.

Strong preferences:
- Bright and spacious.
- A good green view, or a green neighbourhood.
- A private landlord is preferred over an agency.
`.trim();

export const JOBS: SearchJob[] = [
  {
    id: "innsbruck",
    name: "Innsbruck",
    urls: [
      "https://www.willhaben.at/iad/immobilien/mietwohnungen/tirol/innsbruck?rows=90",
    ],
    enabled: true,
    // ── ADJUST ME ──────────────────────────────────────────────────────────
    softCapEur: 1400,
    // ───────────────────────────────────────────────────────────────────────
    maxPages: 10,
    maxDetailsPerRun: 120,
    locationGuidance: `
- Anywhere in Innsbruck is acceptable — location is not a dealbreaker.
- Slight preference for the area behind the main train station, the far side
  of the Inn, Höttinger Au, and Mariahilfstraße.
`.trim(),
  },
  {
    id: "vienna",
    name: "Vienna (6th/7th/8th)",
    urls: [
      "https://www.willhaben.at/iad/immobilien/mietwohnungen/wien/wien-1060-mariahilf?rows=90",
      "https://www.willhaben.at/iad/immobilien/mietwohnungen/wien/wien-1070-neubau?rows=90",
      "https://www.willhaben.at/iad/immobilien/mietwohnungen/wien/wien-1080-josefstadt?rows=90",
    ],
    enabled: true,
    // ── ADJUST ME ──────────────────────────────────────────────────────────
    softCapEur: 1400,
    // ───────────────────────────────────────────────────────────────────────
    maxPages: 5,
    maxDetailsPerRun: 90,
    locationGuidance: `
- The target area is the inner belt: 1060 Mariahilf, 1070 Neubau, 1080
  Josefstadt. These are the districts we actually want — score them highest.
- Directly adjacent inner districts (1010, 1040, 1050, 1090) are acceptable
  but should score somewhat lower.
- Anything outside those districts should score low unless it is exceptional.
- The postal code is the most reliable district signal: the format is 1XX0,
  where XX is the district number (e.g. 1070 = 7th district).
`.trim(),
  },
];

/** Compose the full LLM criteria prompt for a job. */
export function buildCriteria(job: SearchJob): string {
  const sections = [SHARED_CRITERIA, `Location:\n${job.locationGuidance}`];

  if (job.softCapEur != null) {
    sections.push(
      `Budget:\n- Target rent is up to €${job.softCapEur} per month.\n` +
        `- Score listings above that down in proportion to how far over they are, ` +
        `but do NOT exclude them. An excellent listing slightly over budget can still score well.`
    );
  }

  return sections.join("\n\n");
}

export function getEnabledJobs(): SearchJob[] {
  return JOBS.filter((j) => j.enabled);
}

export function getJob(id: string): SearchJob | undefined {
  return JOBS.find((j) => j.id === id);
}

export function findJobByUrl(url: string): SearchJob | undefined {
  return JOBS.find((j) => j.urls.includes(url));
}

/**
 * Resolve a URL to a job. Configured URLs map to their real job so ad-hoc runs
 * behave identically to scheduled ones. Anything else gets a stable synthetic
 * job whose id is derived from the URL, which keeps its listings isolated from
 * the configured jobs when marking rows inactive.
 */
export function resolveJob(url: string): SearchJob {
  const configured = findJobByUrl(url);
  if (configured) return configured;

  const slug = createHash("sha256").update(url).digest("hex").slice(0, 8);
  return {
    id: `adhoc-${slug}`,
    name: `Ad-hoc (${slug})`,
    urls: [url],
    enabled: false,
    softCapEur: null,
    maxPages: 10,
    maxDetailsPerRun: 120,
    locationGuidance: "- No specific location preference.",
  };
}
