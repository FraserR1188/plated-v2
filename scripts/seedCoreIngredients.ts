// ============================================================
// scripts/seedCoreIngredients.ts — ONE-OFF seed importer for
// public.core_ingredients. NOT app code — never imported from src/.
//
// Runs with the SERVICE ROLE key (bypasses RLS by design; core_ingredients
// has no client write policy — see the migration). The app only ever
// SELECTs this table.
//
// USAGE
//   npx tsx scripts/seedCoreIngredients.ts --cofid path/to/cofid.csv [--dry-run] [--limit 10]
//
//   See scripts/seedIngredients/cofid.ts's header comment for the CSV
//   contract CoFID must be flattened into before this will read it.
//
// ENV
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required unless --dry-run
//   FDC_API_KEY                               required (get one free at
//                                              api.data.gov/signup) — the
//                                              run still proceeds without
//                                              it, CoFID-only, with a
//                                              warning, since CoFID alone
//                                              is a legitimate partial run
//
// LICENSING — read before shipping seeded data
//   CoFID 2021 is Crown copyright, Open Government Licence v3.0: free for
//   commercial use, WITH ATTRIBUTION. This importer is not the place to
//   enforce that — it's a product/legal task — but ship an attribution
//   line somewhere a user can find it (About/Settings screen), e.g.
//   "Nutrition data for staple ingredients from McCance and Widdowson's
//   Composition of Foods Integrated Dataset, © Crown copyright, licensed
//   under the Open Government Licence v3.0." FDC is CC0 and needs no
//   attribution, but crediting USDA costs one more line and is normal
//   practice.
//
// IDEMPOTENT — upserts on slug. Re-running after fixing a CSV mapping bug
// or adding staples is safe and expected.
// ============================================================

import { SEED_STAPLES, type SeedStaple } from "./seedStaples";
import { loadCofid, matchCofid } from "./seedIngredients/cofid";
import { lookupFdc } from "./seedIngredients/fdc";
import { coalesceMacros, Macro100, MACRO100_KEYS } from "./seedIngredients/convert";
import { createAdminClient } from "./seedIngredients/db";

interface Args {
  cofidPath: string;
  dryRun: boolean;
  limit?: number;
}

function parseArgs(argv: string[]): Args {
  let cofidPath = "";
  let dryRun = false;
  let limit: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cofid") cofidPath = argv[++i];
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--limit") limit = parseInt(argv[++i], 10);
  }

  if (!cofidPath) {
    throw new Error("Usage: npx tsx scripts/seedCoreIngredients.ts --cofid <path.csv> [--dry-run] [--limit N]");
  }
  return { cofidPath, dryRun, limit };
}

type Row = {
  slug: string;
  display_name: string;
  aliases: string[];
  unit_grams: Record<string, number>;
  density_g_per_ml: number | null;
  source: "cofid" | "fdc" | "merged";
  source_ref: string | null;
  // true ONLY for a staple.cofidOverride row — a human picked this exact
  // CoFID food code by hand. Every matchCofid()-resolved row, CoFID or FDC
  // or merged, is false: an algorithmic pick, however well-anchored, is
  // still a guess until someone has looked at it.
  verified: boolean;
} & Macro100;

function hasAnyValue(m: Partial<Macro100>): boolean {
  return MACRO100_KEYS.some((k) => m[k] != null);
}

function buildRow(
  staple: SeedStaple,
  merged: Macro100,
  source: Row["source"],
  sourceRef: string | null,
  verified: boolean,
): Row {
  return {
    slug: staple.slug,
    display_name: staple.displayName,
    aliases: staple.aliases,
    unit_grams: staple.unitGrams ?? {},
    density_g_per_ml: staple.densityGPerMl ?? null,
    source,
    source_ref: sourceRef,
    verified,
    ...merged,
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const fdcKey = process.env.FDC_API_KEY;
  if (!fdcKey) {
    console.warn("[seed] FDC_API_KEY not set — running CoFID-only. FDC-only NULL fills will not happen.");
  }

  console.log(`[seed] Loading CoFID from ${args.cofidPath}...`);
  const cofidRows = loadCofid(args.cofidPath);
  console.log(`[seed] Loaded ${cofidRows.length} CoFID rows.`);
  // Built once per run, not once per staple — matchCofid() still scans
  // cofidRows linearly per staple (191 staples x a few thousand rows is
  // fine), but an override lookup has no reason to pay that cost too.
  const cofidByCode = new Map(cofidRows.map((r) => [r.foodCode, r]));

  const staples = args.limit ? SEED_STAPLES.slice(0, args.limit) : SEED_STAPLES;

  const outRows: Row[] = [];
  const misses: string[] = [];
  const overrideMisses: string[] = [];
  let cofidOnly = 0;
  let fdcOnly = 0;
  let merged = 0;
  let overrides = 0;

  for (const staple of staples) {
    // An override bypasses matching entirely — see the field's own comment
    // in seedStaples.ts. A code that isn't in THIS CSV is its own outcome,
    // never a silent fall-through to matchCofid(): a human already decided
    // what this staple should be, and a stale/typo'd code degrading
    // quietly into a guess would be worse than skipping it outright.
    if (staple.cofidOverride) {
      const row = cofidByCode.get(staple.cofidOverride);
      if (!row) {
        overrideMisses.push(staple.slug);
        console.warn(
          `[seed] MISS  ${staple.slug} — override ${staple.cofidOverride} not found in this CSV. Skipping (not falling back to matching).`,
        );
        continue;
      }

      console.log(`[seed] OK    ${staple.slug} <- cofid (override) "${row.foodName}"`);
      // No FDC merge for an override — see the field comment: the human
      // picked the row, not just a gap-filler, and it's trusted as-is.
      outRows.push(buildRow(staple, coalesceMacros(row.macros, {}), "cofid", row.foodCode, true));
      cofidOnly++;
      overrides++;
      continue;
    }

    const cofidMatch = matchCofid(staple, cofidRows);
    const fdcMatch = fdcKey ? await lookupFdc(staple, fdcKey) : null;

    if (!cofidMatch && !fdcMatch) {
      misses.push(staple.slug);
      console.warn(`[seed] MISS  ${staple.slug} — no CoFID or FDC match. Skipping.`);
      continue;
    }

    const mergedMacros = coalesceMacros(
      cofidMatch?.macros ?? {},
      fdcMatch?.macros ?? {},
    );

    let source: Row["source"];
    let sourceRef: string | null;
    if (cofidMatch && fdcMatch && hasAnyValue(fdcMatch.macros)) {
      source = "merged";
      sourceRef = cofidMatch.sourceRef; // CoFID is primary — keep its identity
      merged++;
    } else if (cofidMatch) {
      source = "cofid";
      sourceRef = cofidMatch.sourceRef;
      cofidOnly++;
    } else {
      source = "fdc";
      sourceRef = fdcMatch!.sourceRef;
      fdcOnly++;
    }

    console.log(
      `[seed] OK    ${staple.slug} <- ${source}` +
        (cofidMatch ? ` cofid:"${cofidMatch.matchedName}"` : "") +
        (fdcMatch ? ` fdc:"${fdcMatch.matchedName}"` : ""),
    );

    outRows.push(buildRow(staple, mergedMacros, source, sourceRef, false));
  }

  console.log(
    `\n[seed] ${outRows.length} resolved (cofid-only ${cofidOnly}, fdc-only ${fdcOnly}, merged ${merged}, ${overrides} of which overridden), ${misses.length} missed, ${overrideMisses.length} override(s) not found.`,
  );
  if (misses.length > 0) {
    console.log(`[seed] Missed slugs (need manual mapping): ${misses.join(", ")}`);
  }
  if (overrideMisses.length > 0) {
    console.log(`[seed] Override not found for: ${overrideMisses.join(", ")}`);
  }

  if (args.dryRun) {
    console.log("[seed] --dry-run: not writing to Supabase. Sample row:");
    console.log(JSON.stringify(outRows[0], null, 2));
    return;
  }

  const supabase = createAdminClient();

  console.log(`[seed] Upserting ${outRows.length} rows...`);
  const { error } = await supabase.from("core_ingredients").upsert(outRows, { onConflict: "slug" });
  if (error) throw new Error(`Upsert failed: ${error.message}`);

  console.log("[seed] Done.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
