// ============================================================
// PR 5 — the WHOOP scores panel, and how Today mounts it.
//
// Source text rather than a render: these components need a React Native
// runtime this project's Vitest setup deliberately doesn't provide (see
// vitest.setup.ts and the same note in insightsStub.test.ts). The VALUES
// behind the panel are covered for real in whoopScores.test.ts; what's
// asserted here is the layout contract and the wiring, which are facts
// about what these files say.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const read = (rel: string) =>
  fs
    .readFileSync(path.resolve(process.cwd(), rel), "utf8")
    .replace(/\r\n/g, "\n");

const panel = read("src/components/WhoopScoresPanel.tsx");
const today = read("src/screens/TodayScreen.tsx");
const flatToday = today.replace(/\s+/g, " ");

/** Source with comments stripped: several assertions below look for the
 *  SHAPE of a mistake, and the comments explaining that mistake contain
 *  it verbatim. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the panel's layout contract", () => {
  it("is a FIXED 82dp column, not content-sized", () => {
    // The whole point. A column that sized itself to "100" versus "–"
    // would move the ring as you swipe between days.
    expect(panel).toMatch(/WHOOP_PANEL_WIDTH\s*=\s*82/);
    expect(strip(panel)).toMatch(/width:\s*WHOOP_PANEL_WIDTH/);
  });

  it("never derives its width from the content", () => {
    expect(strip(panel)).not.toMatch(/minWidth|maxWidth|flex:\s*1/);
  });

  it("uses an en dash for every unknown, in one place", () => {
    expect(panel).toMatch(/const DASH = "–"/);
    // No second, hand-written dash literal that could drift from it.
    const literals = strip(panel).match(/"–"/g) ?? [];
    expect(literals).toHaveLength(1);
  });

  it("drops the unit beside a dash, so '– %' can't render", () => {
    expect(panel.replace(/\s+/g, " ")).toContain("value !== DASH");
  });

  it("labels WHOOP as text, with no logo or image", () => {
    expect(panel).toContain(">WHOOP<");
    expect(strip(panel)).not.toMatch(/Image|require\(|\.png|\.svg/);
  });

  it("renders strain to 1dp and the percentages as integers", () => {
    // 12 and 12.3 are different readings; recovery and sleep are whole
    // percent by design.
    expect(panel).toMatch(/scores\.strain\.toFixed\(1\)/);
    expect(panel).toMatch(/String\(v\)/);
  });

  it("uses theme tokens only — no hard-coded colours", () => {
    expect(strip(panel)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(strip(panel)).not.toMatch(/rgba?\(/);
  });

  it("uses the mono face for the numbers, so a value change can't shift the column", () => {
    expect(panel).toContain("Fonts.mono.semibold");
  });

  it("renders the strain caption through the shared formatter", () => {
    // The day-aware branch ("as of 14:05" vs "as of Fri 14:05") lives in
    // lib and is tested for real there; the panel must not grow its own.
    expect(panel).toContain("formatStrainCaption(scores.asOf)");
    expect(strip(panel)).not.toMatch(/toLocaleTimeString|getHours\(/);
  });

  it("shows the caption only when there is a strain value", () => {
    // A timestamp under a dash claims the dash is fresh. The guard is the
    // caption being null, which getWhoopScoresForDate already guarantees
    // by nulling asOf alongside a missing strain -- this pins the render
    // side of it too.
    expect(panel.replace(/\s+/g, " ")).toContain("{caption && (");
  });
});

describe("how Today mounts it", () => {
  it("gates on the store's connection state, not Settings' local state", () => {
    expect(flatToday).toContain("useStore((s) => s.whoopConnected)");
    expect(strip(today)).not.toContain("getWhoopConnection");
  });

  it("renders the panel only when connected", () => {
    expect(flatToday).toContain(
      "{whoopConnected && <WhoopScoresPanel scores={whoopScores} />}",
    );
  });

  it("puts the ring and the panel in one row, leaving CalorieRing untouched", () => {
    expect(flatToday).toContain("<View style={styles.ringRow}>");
    // The ring keeps its own fixed size — the offset is the row's business.
    expect(flatToday).toContain("size={200}");
  });

  it("fetches per PAGE date, so swiping follows the page", () => {
    expect(flatToday).toContain("getWhoopScoresForDate(date)");
    expect(flatToday).toMatch(
      /\[date, whoopConnected, whoopRefreshToken\]/,
    );
  });

  it("starts from NO_SCORES, so nothing stale is shown under a new date", () => {
    expect(flatToday).toContain("useState<WhoopScores>(NO_SCORES)");
  });

  it("cancels an in-flight read when the page changes", () => {
    // Without this, a slow read for yesterday can land after a fast one
    // for today and write the wrong day's numbers into the panel.
    expect(flatToday).toContain("if (!cancelled) setWhoopScores(s)");
    expect(flatToday).toContain("cancelled = true");
  });

  it("joins the post-sync refetch rather than polling", () => {
    const app = read("App.tsx").replace(/\s+/g, " ");
    expect(app).toContain("bumpBiometricRefresh()");
    expect(app).toContain("refetchIfSyncWroteData");
  });
});
