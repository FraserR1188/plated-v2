// ============================================================
// src/theme/__tests__/noRawHexColors.test.ts
//
// A source-level (not runtime) invariant test, mirroring
// mealEntriesInsertSites.test.ts's approach: walk the source tree and
// fail loudly if a pattern this codebase has decided against reappears.
//
// The invariant here: every colour in src/ comes from theme/tokens.ts,
// not a hex literal typed directly into a component. tokens.ts is the
// one place new colours belong — that's what keeps the dark-slate
// palette from drifting back to five different hand-typed near-blacks,
// the way the pre-token app did.
// ============================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC_ROOT = path.resolve(process.cwd(), "src");

// tokens.ts IS the palette — every hex literal in the app is allowed to
// live there exactly once, as the source of truth everything else reads.
const ALLOWED_FILES = new Set(["theme/tokens.ts"]);

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, out);
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !full.split(path.sep).includes("__tests__")
    ) {
      out.push(full);
    }
  }
  return out;
}

// A real CSS-style hex colour literal (#fff, #ffffff, #ffffff80, ...) — the
// negative lookahead stops a 6/8-digit hex from also registering as a false
// 3/4-digit match on its own leading digits.
const HEX_COLOR =
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g;

const files = walkTsFiles(SRC_ROOT);

const violations = files
  .map((file) => {
    const rel = path.relative(SRC_ROOT, file).replace(/\\/g, "/");
    if (ALLOWED_FILES.has(rel)) return null;
    const text = fs.readFileSync(file, "utf8");
    const matches = text.match(HEX_COLOR);
    return matches ? { file: rel, colors: [...new Set(matches)] } : null;
  })
  .filter((v): v is { file: string; colors: string[] } => v !== null);

describe("no raw hex colours outside theme/tokens.ts (structural)", () => {
  it("every colour in src/ comes from theme/tokens.ts, not a literal hex string", () => {
    // If this fails: a raw hex like "#1A2B3C" was typed directly into a
    // component instead of being added to src/theme/tokens.ts and imported
    // from there. Add the colour to tokens.ts once (or reuse an existing
    // token) and reference it — don't retype the hex at the call site.
    expect(
      violations,
      violations.map((v) => `${v.file}: ${v.colors.join(", ")}`).join("\n"),
    ).toEqual([]);
  });
});
