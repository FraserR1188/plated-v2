// ============================================================
// The tab bar's shape, pinned.
//
// Which routes are tabs, in what order, is a product decision that has now
// changed twice — and it is invisible to tsc, which is happy with any set
// of Tab.Screen names that exist in BottomTabParamList. These read the
// navigator's source rather than mounting it: React Navigation needs a
// full React Native runtime, which this project's Vitest setup
// deliberately doesn't provide (see vitest.setup.ts on react-native's Flow
// syntax), and the question here is structural, not behavioural.
//
// The icon check closes the other half of the gap the tsc typing now
// covers: TabBar's icon map is keyed by route name and typed to
// BottomTabParamList, so a missing icon is a compile error rather than a
// silent "·" — this asserts the same thing at runtime, in case the map is
// ever loosened back to Record<string, ...>.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import ts from "typescript";

const SRC_ROOT = path.resolve(process.cwd(), "src");

function parse(relPath: string): { text: string; sourceFile: ts.SourceFile } {
  const full = path.join(SRC_ROOT, relPath);
  const text = fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n");
  return {
    text,
    sourceFile: ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
  };
}

/** Names of every <X.Screen name="..."> under the given JSX prefix, in source order. */
function screenNames(sourceFile: ts.SourceFile, prefix: "Tab" | "Stack"): string[] {
  const names: string[] = [];

  const visit = (node: ts.Node): void => {
    const opening = ts.isJsxSelfClosingElement(node)
      ? node
      : ts.isJsxElement(node)
        ? node.openingElement
        : null;

    if (opening && opening.tagName.getText(sourceFile) === `${prefix}.Screen`) {
      for (const attr of opening.attributes.properties) {
        if (
          ts.isJsxAttribute(attr) &&
          attr.name.getText(sourceFile) === "name" &&
          attr.initializer &&
          ts.isStringLiteral(attr.initializer)
        ) {
          names.push(attr.initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return names;
}

/** Keys of the first object literal assigned to `const <name> = { ... }`. */
function objectLiteralKeys(sourceFile: ts.SourceFile, name: string): string[] {
  let keys: string[] | null = null;

  const visit = (node: ts.Node): void => {
    if (
      keys === null &&
      ts.isVariableDeclaration(node) &&
      node.name.getText(sourceFile) === name &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      keys = node.initializer.properties.flatMap((p) =>
        p.name ? [p.name.getText(sourceFile).replace(/['"]/g, "")] : [],
      );
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  if (keys === null) throw new Error(`No object literal named ${name} found`);
  return keys;
}

const navigator = parse("navigation/AppNavigator.tsx");
const tabBar = parse("components/TabBar.tsx");
const types = parse("types/index.ts");

/** Members of a `export type X = { ... }` declaration, in source order. */
function typeMembers(sourceFile: ts.SourceFile, name: string): string[] {
  let members: string[] | null = null;

  const visit = (node: ts.Node): void => {
    if (
      members === null &&
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === name &&
      ts.isTypeLiteralNode(node.type)
    ) {
      members = node.type.members.flatMap((m) =>
        m.name ? [m.name.getText(sourceFile).replace(/['"]/g, "")] : [],
      );
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  if (members === null) throw new Error(`No type alias named ${name} found`);
  return members;
}

// Friends left the bar for a Settings row (the header icons for Batches
// and Bundles didn't read as anything), and Batches came back to it.
//
// Part 4: "History" became "Data", because the tab now holds two things --
// the day-by-day History list and the new Trends charts. The ROUTE was
// renamed, not just the label: TAB_ICONS and BottomTabParamList are both
// keyed by route name, so tsc drags every reference along with it. The
// assertions below are what stops the two drifting apart again.
const EXPECTED_TABS = [
  "Today",
  "Data",
  "Insights",
  "Batches",
  "Settings",
];

describe("bottom tabs", () => {
  it("registers exactly the expected tabs, in order", () => {
    expect(screenNames(navigator.sourceFile, "Tab")).toEqual(EXPECTED_TABS);
  });

  // Insights is meant to sit in the MIDDLE of the bar, which only holds
  // while the count is odd and it is the median entry. Worth pinning as
  // its own assertion: the order test above would still pass if a sixth
  // tab were added or Insights were moved one place along.
  //
  // Now unconditional: SOCIAL_ENABLED used to hide the Friends TAB, which
  // left four rendered and pushed Insights off-centre. The flag now only
  // hides a row inside Settings, so the bar is five either way.
  it("puts Insights in the centre slot", () => {
    const tabs = screenNames(navigator.sourceFile, "Tab");
    expect(tabs.length % 2).toBe(1);
    expect(tabs[(tabs.length - 1) / 2]).toBe("Insights");
  });

  it("keeps BottomTabParamList in step with the tabs actually registered", () => {
    expect(typeMembers(types.sourceFile, "BottomTabParamList").sort()).toEqual(
      [...EXPECTED_TABS].sort(),
    );
  });

  it("gives every tab an icon — no route falls through to the placeholder", () => {
    expect(objectLiteralKeys(tabBar.sourceFile, "TAB_ICONS").sort()).toEqual(
      [...EXPECTED_TABS].sort(),
    );
  });

  // The map used to be keyed on the tab's LABEL, which is a display string
  // that nothing stops drifting from the route name.
  it("looks icons up by route name", () => {
    expect(tabBar.text).toMatch(/TAB_ICONS\[\s*route\.name/);
  });

  it("labels the Data tab \"Data\", not \"History\"", () => {
    expect(navigator.text).toMatch(/tabBarLabel:\s*"Data"/);
    expect(navigator.text).not.toMatch(/tabBarLabel:\s*"History"/);
  });

  // The rename has to be total. A leftover navigate("History") compiles
  // only until BottomTabParamList drops the key, and a leftover icon entry
  // would leave the Data tab on the "·" placeholder -- so assert the name
  // is gone from all three files that know about routes, not just renamed
  // in the navigator.
  it("leaves no \"History\" route behind in the navigator, the icon map or the param list", () => {
    expect(navigator.text).not.toMatch(/name="History"/);
    expect(objectLiteralKeys(tabBar.sourceFile, "TAB_ICONS")).not.toContain(
      "History",
    );
    expect(typeMembers(types.sourceFile, "BottomTabParamList")).not.toContain(
      "History",
    );
  });

  // AppNavigator carried a second, unused TAB_ICONS/TabIcon pair that
  // rendered nothing — it existed only to satisfy the typed tabBarIcon
  // option and had already drifted from the icons actually on screen.
  // Matches DECLARATIONS, not mentions: the comment left in its place
  // names both, on purpose, so nobody re-adds them.
  it("has no second icon map in the navigator", () => {
    expect(navigator.text).not.toMatch(/\b(?:const|let|var)\s+TAB_ICONS\b/);
    expect(navigator.text).not.toMatch(/\bfunction\s+TabIcon\b/);
  });
});

describe("Batches", () => {
  it("is a tab, not a root-stack screen", () => {
    expect(screenNames(navigator.sourceFile, "Tab")).toContain("Batches");
    expect(screenNames(navigator.sourceFile, "Stack")).not.toContain("Batches");
  });

  it("is not left behind in RootStackParamList", () => {
    expect(typeMembers(types.sourceFile, "RootStackParamList")).not.toContain(
      "Batches",
    );
  });
});

describe("Friends", () => {
  const settings = parse("screens/SettingsScreen.tsx");

  it("is a root-stack screen, not a tab", () => {
    expect(screenNames(navigator.sourceFile, "Stack")).toContain("Friends");
    expect(screenNames(navigator.sourceFile, "Tab")).not.toContain("Friends");
  });

  it("is reachable: RootStackParamList declares it and Settings navigates there", () => {
    expect(typeMembers(types.sourceFile, "RootStackParamList")).toContain(
      "Friends",
    );
    expect(settings.text).toMatch(/navigate\(\s*["']Friends["']\s*\)/);
  });

  // The row is a social surface, so it answers to the same flag the tab
  // used to. The flag moved out of TabBar (a component Settings cannot
  // sensibly import) into lib/flags.
  it("is gated on SOCIAL_ENABLED, now shared from lib/flags", () => {
    expect(settings.text).toMatch(
      /import \{[^}]*SOCIAL_ENABLED[^}]*\} from "\.\.\/lib\/flags"/,
    );
    expect(settings.text).toMatch(/SOCIAL_ENABLED &&/);
    expect(tabBar.text).toMatch(
      /import \{[^}]*SOCIAL_ENABLED[^}]*\} from "\.\.\/lib\/flags"/,
    );
    expect(tabBar.text).not.toMatch(/const SOCIAL_ENABLED\s*=/);
  });
});

describe("the pending-requests badge", () => {
  const settings = parse("screens/SettingsScreen.tsx");

  // Same store value in both places, so they cannot drift apart.
  it("counts from the store in both places", () => {
    expect(tabBar.text).toMatch(/incomingRequestCount/);
    expect(settings.text).toMatch(/incomingRequestCount/);
  });

  it("rides the Settings tab now that Friends has no tab of its own", () => {
    expect(tabBar.text).toMatch(/route\.name === "Settings"/);
    expect(tabBar.text).not.toMatch(/route\.name === "Friends"/);
  });

  // One component, so the tab and the row render an identical badge
  // rather than two lookalikes that drift.
  it("is the shared CountBadge in both places", () => {
    for (const f of [tabBar, settings]) {
      expect(f.text).toMatch(/<CountBadge/);
      expect(f.text).toMatch(/from "(\.\.\/components)?\.?\/?CountBadge"/);
    }
  });
});
