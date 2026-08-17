/*
 * Unit tests for the pure parts of scripts/version.ts.
 *
 * The git and gh orchestration is NOT covered here and no attempt is made to
 * fake it: mocking `$` would test the mock. `DRY_RUN=1 bun run version <part>`
 * is what exercises that half, by printing every mutating command instead of
 * running it. This file covers the two functions where a wrong answer is
 * silent — a bump that lands on the wrong number, and a version check that
 * says a tree is fine when it is not.
 *
 * Importing this module at all depends on version.ts's `import.meta.main`
 * guard. Without it, this import would cut a release.
 */
import { describe, expect, test } from "bun:test";
import { bump, releaseBranchName, verifyCommittedVersion } from "./version";

describe("bump", () => {
  test("major zeroes minor and patch", () => {
    expect(bump("2.0.1", "major")).toBe("3.0.0");
    expect(bump("1.4.9", "major")).toBe("2.0.0");
  });

  test("minor zeroes patch and keeps major", () => {
    // The case that regressed once: `bun run version minor` produced a patch
    // bump because the part was read from the wrong argv index.
    expect(bump("2.0.1", "minor")).toBe("2.1.0");
    expect(bump("0.27.13", "minor")).toBe("0.28.0");
  });

  test("patch increments only the patch", () => {
    expect(bump("2.0.0", "patch")).toBe("2.0.1");
    expect(bump("0.27.13", "patch")).toBe("0.27.14");
  });

  test("defaults to patch", () => {
    expect(bump("2.0.1")).toBe("2.0.2");
  });

  test("throws on an unknown part rather than guessing", () => {
    expect(() => bump("2.0.1", "mayor")).toThrow(/Invalid semver part: mayor/);
  });

  test("throws on a version that is not three numeric parts", () => {
    expect(() => bump("2.0", "patch")).toThrow(/three-part semver/);
    expect(() => bump("2.0.1-rc.1", "patch")).toThrow(/three-part semver/);
  });
});

describe("releaseBranchName", () => {
  test("is the name publish-side steps expect", () => {
    expect(releaseBranchName("2.0.2")).toBe("chore/release-2.0.2");
  });
});

describe("verifyCommittedVersion", () => {
  const files = (version: string, versionsKey = version) => ({
    pkg: JSON.stringify({ name: "x", version }),
    manifest: JSON.stringify({ id: "x", version, minAppVersion: "1.7.2" }),
    versions: JSON.stringify({ "1.0.1": "1.7.2", [versionsKey]: "1.7.2" }),
  });

  test("no problems when all three agree", () => {
    expect(verifyCommittedVersion(files("2.0.2"), "2.0.2")).toEqual([]);
  });

  test("names a stale package.json", () => {
    const f = files("2.0.2");
    f.pkg = JSON.stringify({ name: "x", version: "2.0.1" });
    const problems = verifyCommittedVersion(f, "2.0.2");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/package\.json at HEAD says "2\.0\.1"/);
  });

  test("names a stale manifest.json", () => {
    const f = files("2.0.2");
    f.manifest = JSON.stringify({ id: "x", version: "2.0.1" });
    const problems = verifyCommittedVersion(f, "2.0.2");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/manifest\.json at HEAD says "2\.0\.1"/);
  });

  test("names a versions.json missing the entry", () => {
    const problems = verifyCommittedVersion(files("2.0.2", "2.0.1"), "2.0.2");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /versions\.json at HEAD has no entry for 2\.0\.2/,
    );
  });

  test("reports every disagreement, not just the first", () => {
    const problems = verifyCommittedVersion(
      {
        pkg: JSON.stringify({ version: "2.0.1" }),
        manifest: JSON.stringify({ version: "1.9.9" }),
        versions: JSON.stringify({ "1.0.1": "1.7.2" }),
      },
      "2.0.2",
    );
    expect(problems).toHaveLength(3);
  });

  test("an unparseable file is a problem, never silently fine", () => {
    const f = files("2.0.2");
    f.manifest = "{ not json";
    const problems = verifyCommittedVersion(f, "2.0.2");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/manifest\.json at HEAD does not parse/);
  });

  test("an absent version field is a mismatch, not a pass", () => {
    const f = files("2.0.2");
    f.pkg = JSON.stringify({ name: "x" });
    expect(verifyCommittedVersion(f, "2.0.2")[0]).toMatch(/says undefined/);
  });
});
