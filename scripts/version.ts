/*
 * Cuts a release, in two commands with a human gate between them.
 *
 *   bun run version <major|minor|patch>   prepares: bump, branch, commit, push
 *                                         the branch, open the PR. Publishes
 *                                         nothing.
 *   bun run version:tag                   publishes: tags `main` and pushes
 *                                         the tag, which is what release.yml
 *                                         triggers on. Point of no return.
 *
 * It used to be one command ending in `git push -u origin main`, and `main`
 * refuses a direct push: a ruleset requires a pull request and classic branch
 * protection requires `check-and-test` and `bridge-tests` to pass. Every tag
 * before 2.0.0 points at a version commit pushed straight to main, so the old
 * shape worked when those were cut and the rules tightened afterwards. 2.0.0
 * and 2.0.1 were both cut by hand around the failure (OMC-032).
 *
 * The tag is created in phase TWO, after the commit is on main, and that is
 * the substantive change rather than a reordering. Tagging before the push
 * meant the tag pointed at a pre-merge commit, so the manual recovery had to
 * insist on a merge commit and a squash would have orphaned the tag. Tagging
 * after means the tag points at whatever main actually has, so either merge
 * method is correct and that constraint is gone.
 *
 * DRY_RUN=1 prints every mutating command instead of running it, and still
 * runs every read-only preflight. It is the only way to exercise this flow
 * without cutting a real release.
 */
import { $ } from "bun";
import { readFileSync, writeFileSync } from "fs";

const DRY_RUN = !!process.env.DRY_RUN;
const FORCE = !!process.env.FORCE;

const PKG_PATH = "./package.json";
const MANIFEST_PATH = "./manifest.json";
const VERSIONS_PATH = "./versions.json";

export type SemverPart = "major" | "minor" | "patch";

export function bump(version: string, semverPart: string = "patch"): string {
  const parts = version.split(".").map((s) => parseInt(s, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`Not a three-part semver: ${version}`);
  }
  const [major, minor, patch] = parts as [number, number, number];
  switch (semverPart) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`Invalid semver part: ${semverPart}`);
  }
}

export function releaseBranchName(version: string): string {
  return `chore/release-${version}`;
}

/**
 * Every way the three version files can disagree with `version`, as
 * human-readable lines. Empty means they agree.
 *
 * Phase two feeds this the files as COMMITTED at HEAD, not as they sit on
 * disk, which is the check that makes tagging the wrong commit impossible.
 * Nothing equivalent existed before: the old script tagged whatever HEAD was
 * without ever looking at what HEAD contained.
 */
export function verifyCommittedVersion(
  files: { pkg: string; manifest: string; versions: string },
  version: string,
): string[] {
  const problems: string[] = [];
  const read = (
    label: string,
    text: string,
  ): Record<string, unknown> | null => {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
      problems.push(`${label} at HEAD does not parse as JSON: ${String(err)}`);
      return null;
    }
  };
  const pkg = read("package.json", files.pkg);
  if (pkg && pkg.version !== version) {
    problems.push(
      `package.json at HEAD says ${JSON.stringify(pkg.version)}, expected ${version}`,
    );
  }
  const manifest = read("manifest.json", files.manifest);
  if (manifest && manifest.version !== version) {
    problems.push(
      `manifest.json at HEAD says ${JSON.stringify(manifest.version)}, expected ${version}`,
    );
  }
  const versions = read("versions.json", files.versions);
  if (versions && !(version in versions)) {
    problems.push(`versions.json at HEAD has no entry for ${version}`);
  }
  return problems;
}

function die(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

/** Runs a mutating command, or prints it under DRY_RUN. */
async function run(argv: string[]): Promise<void> {
  if (DRY_RUN) {
    console.log(`  would run: ${argv.join(" ")}`);
    return;
  }
  const [cmd, ...args] = argv;
  await $`${cmd} ${args}`;
}

async function gitText(argv: string[]): Promise<string> {
  const [cmd, ...args] = argv;
  return (await $`${cmd} ${args}`.quiet()).text().trim();
}

/**
 * The preflight both phases share. Read-only, so it runs for real even under
 * DRY_RUN — a dry run that skipped the checks would prove nothing about the
 * real one.
 *
 * The origin/main comparison is new. A stale local main would have based a
 * release on old code, and the old script had nothing to say about it.
 */
async function assertReleasableMain(): Promise<void> {
  const status = await gitText(["git", "status", "--porcelain"]);
  if (status && !FORCE) {
    die(
      "There are uncommitted changes. Commit them before releasing, or run with FORCE=true.",
    );
  }
  const branch = await gitText(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main" && !FORCE) {
    die(
      `On branch ${branch}, not main. Switch to main, or run with FORCE=true.`,
    );
  }
  await $`git fetch origin main --tags`.quiet();
  const local = await gitText(["git", "rev-parse", "HEAD"]);
  const remote = await gitText(["git", "rev-parse", "origin/main"]);
  if (local !== remote && !FORCE) {
    die(
      `Local main (${local.slice(0, 7)}) is not origin/main (${remote.slice(0, 7)}).\n` +
        `  Pull or push first — releasing from a stale main ships the wrong tree.\n` +
        `  Override with FORCE=true only if you know exactly why.`,
    );
  }
}

async function prepare(semverPart: string): Promise<void> {
  await assertReleasableMain();

  const pkg = await Bun.file(PKG_PATH).json();
  const version = bump(pkg.version, semverPart);
  const branch = releaseBranchName(version);

  const existing = await gitText(["git", "tag", "-l", version]);
  if (existing) {
    die(`Tag ${version} already exists locally. Nothing to prepare.`);
  }

  console.log(`\nPreparing ${pkg.version} → ${version} (${semverPart})\n`);

  // Serialisation is load-bearing and deliberately unchanged: two spaces plus
  // a trailing newline for package.json and manifest.json, a tab for
  // versions.json. The 2.0.1 bump had to be replicated by hand and any drift
  // here would have shown up as an unrelated diff in the release commit.
  pkg.version = version;
  if (!DRY_RUN) {
    await Bun.write(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");
  }

  const manifest = await Bun.file(MANIFEST_PATH).json();
  const { minAppVersion } = manifest;
  manifest.version = version;
  if (!DRY_RUN) {
    await Bun.write(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  }

  const versions = JSON.parse(readFileSync(VERSIONS_PATH, "utf8"));
  versions[version] = minAppVersion;
  if (!DRY_RUN) {
    writeFileSync(VERSIONS_PATH, JSON.stringify(versions, null, "\t") + "\n");
  }
  console.log(
    `  ${DRY_RUN ? "would write" : "wrote"} package.json, manifest.json, versions.json (minAppVersion ${minAppVersion})`,
  );

  await run(["git", "checkout", "-b", branch]);
  await run(["git", "add", PKG_PATH, MANIFEST_PATH, VERSIONS_PATH]);
  await run(["git", "commit", "-m", version]);
  await run(["git", "push", "-u", "origin", branch]);

  // gh is not a hard dependency. The branch is already pushed by this point,
  // which is the part that cannot be redone by hand in a second; opening a PR
  // from a URL can.
  const hasGh = await Bun.which("gh");
  if (hasGh) {
    await run([
      "gh",
      "pr",
      "create",
      "--title",
      `chore(release): ${version}`,
      "--body",
      `Version bump only: \`package.json\`, \`manifest.json\`, \`versions.json\`.\n\n` +
        `Merge this once CI is green, pull \`main\`, then run \`bun run version:tag\` to tag and publish. ` +
        `Either merge method is fine — the tag is created after the merge, so it points at whatever \`main\` has.`,
    ]);
  } else {
    console.log(
      `  gh not found — open the PR by hand:\n` +
        `    https://github.com/istefox/obsidian-mcp-connector/compare/${branch}?expand=1`,
    );
  }

  console.log(
    `\n${DRY_RUN ? "[dry run] " : ""}Prepared. Nothing is published yet.\n` +
      `  1. wait for CI, then merge the PR (squash or merge commit, either is correct)\n` +
      `  2. git checkout main && git pull --ff-only\n` +
      `  3. bun run version:tag        ← tags ${version} and pushes it; release.yml runs on that\n`,
  );
}

async function tagAndPublish(): Promise<void> {
  await assertReleasableMain();

  // Read from the COMMITTED package.json, not from disk. Taking it from disk
  // and then comparing it against HEAD would be tautological on a clean tree,
  // which the preflight above has already insisted on — the two are the same
  // file. What this pair of steps genuinely buys is the agreement of the three
  // files with each other at the exact commit about to be tagged, which a
  // partial merge or a hand-edit can break.
  const committedPkg = await gitText(["git", "show", "HEAD:package.json"]);
  let version: string;
  try {
    version = JSON.parse(committedPkg).version;
  } catch (err) {
    die(`package.json at HEAD does not parse as JSON: ${String(err)}`);
  }
  if (typeof version !== "string" || version === "") {
    die("package.json at HEAD has no version string. Nothing to tag.");
  }

  const problems = verifyCommittedVersion(
    {
      pkg: committedPkg,
      manifest: await gitText(["git", "show", "HEAD:manifest.json"]),
      versions: await gitText(["git", "show", "HEAD:versions.json"]),
    },
    version,
  );
  if (problems.length > 0) {
    die(
      `main's committed tree does not agree on ${version}:\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        `\n  A partial merge or a hand-edit leaves exactly this shape.`,
    );
  }

  if (await gitText(["git", "tag", "-l", version])) {
    die(`Tag ${version} already exists locally.`);
  }
  if (await gitText(["git", "ls-remote", "--tags", "origin", version])) {
    die(`Tag ${version} already exists on origin. A release cannot be re-cut.`);
  }

  console.log(
    `\nTagging ${version} at ${(await gitText(["git", "rev-parse", "HEAD"])).slice(0, 7)}\n`,
  );
  await run(["git", "tag", version]);
  await run(["git", "push", "origin", version]);
  console.log(
    `\n${DRY_RUN ? "[dry run] " : ""}${DRY_RUN ? "Would publish" : "Published"} ${version}.` +
      `${DRY_RUN ? "" : " That was the point of no return."}\n` +
      `  release.yml builds, attests and publishes off the tag. Watch it:\n` +
      `    gh run watch --exit-status\n`,
  );
}

// `bun run version <part>` gives Bun an argv of [bunBinary, scriptPath, <part>],
// so the user-supplied part is at index 2. It used to read argv[3], which is
// always undefined under that call convention, so every invocation silently
// fell back to "patch" — caught while preparing the 0.3.0 cut, where
// `bun run version minor` produced 0.2.28.
// `import.meta.main` is not decoration. Without it, importing this module to
// unit-test its pure functions would CUT A RELEASE, because the dispatch below
// is top-level.
if (import.meta.main) {
  const arg = Bun.argv[2];
  if (arg === "--tag") {
    await tagAndPublish();
  } else {
    await prepare(arg || "patch");
  }
}
