import { execSync } from "node:child_process";

const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
const fail = (m) => {
  console.error(`publish-prod: ${m}`);
  process.exit(1);
};
const json = (c) => {
  const out = sh(c);
  try {
    return JSON.parse(out);
  } catch {
    fail(`not JSON from '${c}':\n${out.slice(0, 500)}`);
  }
};

const message = process.argv.slice(2).join(" ");
if (!message) fail('usage: node scripts/publish-prod.mjs "<update message>"');

sh("git fetch origin master");
const branch = sh("git rev-parse --abbrev-ref HEAD");
if (branch !== "master")
  fail(`on '${branch}' - production publishes only from master`);
if (sh("git status --porcelain")) fail("working tree not clean");
const head = sh("git rev-parse HEAD");
const remote = sh("git rev-parse origin/master");
if (head !== remote)
  fail(
    `HEAD ${head.slice(0, 7)} != origin/master ${remote.slice(0, 7)} - push or pull first`,
  );

// An update only reaches binaries whose runtime version matches its own, so
// a tree whose fingerprint has drifted from the store build would publish to
// nobody. Compare this tree against each platform's latest finished
// production build, and check both before refusing so one run shows every
// mismatch.
const problems = [];
for (const platform of ["android", "ios"]) {
  const local = json(
    `npx expo-updates runtimeversion:resolve --platform ${platform}`,
  ).runtimeVersion;
  const [build] = json(
    `eas build:list --platform ${platform} --profile production --status finished --limit 1 --json --non-interactive`,
  );
  const built = build?.runtimeVersion;
  console.log(
    `publish-prod: ${platform} this tree ${local ?? "(none)"}, latest production build ${built ?? "(none)"}` +
      (build
        ? ` (build ${build.appBuildVersion}, ${build.gitCommitHash?.slice(0, 7)})`
        : ""),
  );
  if (!build || !built)
    problems.push(`${platform}: no finished production build to match`);
  else if (local !== built)
    problems.push(
      `${platform}: runtime ${local ?? "(none)"} != production build ${built} - native change, needs a store build`,
    );
}
if (problems.length) fail(`refusing to publish\n  ${problems.join("\n  ")}`);

console.log(
  `publish-prod: master @ ${head.slice(0, 7)}, publishing to production`,
);
execSync(
  `eas update --channel production --message ${JSON.stringify(message)}`,
  { stdio: "inherit" },
);
