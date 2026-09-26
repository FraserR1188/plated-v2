import { describe, it, expect } from "vitest";
import { parseSeedArgs, selectStaples } from "../args";
import { SEED_STAPLES } from "../../seedStaples";

// Parse and select together, the way run() uses them — a test of either
// half alone would pass with the other half ignoring --only.
function stapleSlugs(argv: string[]): string[] {
  return selectStaples(SEED_STAPLES, parseSeedArgs(argv)).map((s) => s.slug);
}

describe("--only", () => {
  it("narrows the run to exactly the named slugs", () => {
    expect(stapleSlugs(["--cofid", "x.csv", "--only", "apple,lime"])).toEqual(["lime", "apple"]);
  });

  it("tolerates spaces around the commas", () => {
    expect(stapleSlugs(["--cofid", "x.csv", "--only", "apple, pear"]).sort()).toEqual(["apple", "pear"]);
  });

  it("throws on a slug that isn't a staple, rather than writing nothing", () => {
    expect(() => stapleSlugs(["--cofid", "x.csv", "--only", "apple,aple"])).toThrow(/aple/);
  });

  it("throws on an empty list, rather than meaning every staple", () => {
    expect(() => parseSeedArgs(["--cofid", "x.csv", "--only", ""])).toThrow(/at least one slug/);
    expect(() => parseSeedArgs(["--cofid", "x.csv", "--only"])).toThrow(/at least one slug/);
  });

  it("can't be combined with --limit", () => {
    expect(() => parseSeedArgs(["--cofid", "x.csv", "--limit", "5", "--only", "apple"])).toThrow(/combined/);
  });
});

describe("without --only", () => {
  it("still selects every staple", () => {
    expect(stapleSlugs(["--cofid", "x.csv"])).toHaveLength(SEED_STAPLES.length);
  });

  it("still honours --limit", () => {
    expect(stapleSlugs(["--cofid", "x.csv", "--limit", "3"])).toEqual(SEED_STAPLES.slice(0, 3).map((s) => s.slug));
  });
});
