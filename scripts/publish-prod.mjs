import { execSync } from "node:child_process";

const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
const fail = (m) => {
  console.error(`publish-prod: ${m}`);
  process.exit(1);
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

console.log(
  `publish-prod: master @ ${head.slice(0, 7)}, publishing to production`,
);
execSync(
  `eas update --channel production --message ${JSON.stringify(message)}`,
  { stdio: "inherit" },
);
