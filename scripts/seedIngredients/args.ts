// ============================================================
// scripts/seedIngredients/args.ts — argv parsing and staple selection for
// the seed importer.
//
// Split out of scripts/seedCoreIngredients.ts for the same reason as ./db:
// that file runs itself at module scope, so a test can't import it. Keeping
// the parse and the filter here means a test can prove that `--only` both
// reaches the args AND narrows the staple list — the two halves that have
// to hold for a targeted run to write only what was approved.
//
// WHY --only EXISTS
//   A whole-table run re-resolves every staple, including the ones with no
//   cofidOverride: those are re-picked by matchCofid() and a LIVE FDC
//   lookup, so a run without FDC_API_KEY (or on a day FDC answers
//   differently) silently rewrites rows nobody asked to change. --only
//   limits the run — and therefore the upsert — to the slugs named.
// ============================================================

import type { SeedStaple } from "../seedStaples";

export interface SeedArgs {
  cofidPath: string;
  dryRun: boolean;
  limit?: number;
  /** Slugs to import, and nothing else. Undefined = every staple. */
  only?: string[];
}

const USAGE =
  "Usage: npx tsx scripts/seedCoreIngredients.ts --cofid <path.csv> [--dry-run] [--limit N | --only slug,slug]";

export function parseSeedArgs(argv: string[]): SeedArgs {
  let cofidPath = "";
  let dryRun = false;
  let limit: number | undefined;
  let only: string[] | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cofid") cofidPath = argv[++i];
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--limit") limit = parseInt(argv[++i], 10);
    else if (a === "--only") {
      only = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      // An empty --only must not quietly mean "everything".
      if (only.length === 0) throw new Error(`--only needs at least one slug. ${USAGE}`);
    }
  }

  if (!cofidPath) throw new Error(USAGE);
  // Both narrow the run in different ways; which one wins would be a guess.
  if (limit != null && only) throw new Error(`--limit and --only can't be combined. ${USAGE}`);
  return { cofidPath, dryRun, limit, only };
}

/**
 * The staples this run resolves and upserts. An `--only` slug that isn't in
 * SEED_STAPLES throws rather than being dropped: a typo'd slug would
 * otherwise produce a "successful" run that wrote nothing it was meant to.
 */
export function selectStaples(all: SeedStaple[], args: Pick<SeedArgs, "limit" | "only">): SeedStaple[] {
  if (args.only) {
    const known = new Set(all.map((s) => s.slug));
    const unknown = args.only.filter((slug) => !known.has(slug));
    if (unknown.length > 0) {
      throw new Error(`--only: not in SEED_STAPLES: ${unknown.join(", ")}`);
    }
    const wanted = new Set(args.only);
    return all.filter((s) => wanted.has(s.slug));
  }
  return args.limit ? all.slice(0, args.limit) : all;
}
