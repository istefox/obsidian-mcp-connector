import { describe, expect, test } from "bun:test";
import { resolveSubpath } from "obsidian";
import {
  headingEntriesFromCache,
  headingPathToSubpath,
  resolveHeadingEntries,
  splitHeadingPath,
} from "./anchorTargets";

interface FixtureHeading {
  heading: string;
  level: number;
  line: number;
}

function metadata(headings: FixtureHeading[]) {
  return {
    headings: headings.map(({ heading, level, line }) => ({
      heading,
      level,
      position: {
        start: { line, col: 0, offset: line * 10 },
        end: {
          line,
          col: heading.length,
          offset: line * 10 + heading.length,
        },
      },
    })),
  };
}

function resolveShared(
  cache: ReturnType<typeof metadata>,
  target: string,
  delimiter: string,
) {
  const totalLines =
    Math.max(0, ...cache.headings.map(({ position }) => position.start.line)) +
    1;
  return resolveHeadingEntries(
    headingEntriesFromCache(cache),
    splitHeadingPath(target, delimiter),
    totalLines,
  );
}

describe("anchor target differential contract (R-13)", () => {
  test.each([
    {
      name: "exact case",
      cache: metadata([{ heading: "Overview", level: 1, line: 0 }]),
      target: "Overview",
      delimiter: "::",
      expectedFound: true,
    },
    {
      name: "folded case",
      cache: metadata([{ heading: "Overview", level: 1, line: 0 }]),
      target: "oVeRvIeW",
      delimiter: "::",
      expectedFound: true,
    },
    {
      name: "nested two-segment path",
      cache: metadata([
        { heading: "Parent", level: 1, line: 0 },
        { heading: "Child", level: 2, line: 2 },
      ]),
      target: "Parent::Child",
      delimiter: "::",
      expectedFound: true,
    },
    {
      name: "nested three-segment path with a custom delimiter",
      cache: metadata([
        { heading: "Root", level: 1, line: 0 },
        { heading: "Branch", level: 2, line: 2 },
        { heading: "Leaf", level: 3, line: 4 },
      ]),
      target: "Root > Branch > Leaf",
      delimiter: " > ",
      expectedFound: true,
    },
    {
      name: "missing leaf",
      cache: metadata([
        { heading: "Parent", level: 1, line: 0 },
        { heading: "Child", level: 2, line: 2 },
      ]),
      target: "Parent::Missing",
      delimiter: "::",
      expectedFound: false,
    },
    {
      name: "missing intermediate",
      cache: metadata([
        { heading: "Root", level: 1, line: 0 },
        { heading: "Other", level: 2, line: 2 },
        { heading: "Leaf", level: 3, line: 4 },
      ]),
      target: "Root::Missing::Leaf",
      delimiter: "::",
      expectedFound: false,
    },
  ])("agrees with resolveSubpath for $name", (fixture) => {
    const sharedFound =
      resolveShared(fixture.cache, fixture.target, fixture.delimiter).kind ===
      "found";
    const obsidianFound =
      resolveSubpath(
        fixture.cache,
        headingPathToSubpath(fixture.target, fixture.delimiter),
      ) !== null;

    expect(sharedFound).toBe(fixture.expectedFound);
    expect(obsidianFound).toBe(fixture.expectedFound);
    expect(sharedFound).toBe(obsidianFound);
  });

  test("records duplicate headings as an intentional ambiguity divergence", () => {
    const cache = metadata([
      { heading: "Repeated", level: 2, line: 1 },
      { heading: "Repeated", level: 2, line: 3 },
    ]);
    const shared = resolveShared(cache, "Repeated", "::");
    const obsidian = resolveSubpath(cache, "#Repeated");

    expect(shared.kind).toBe("ambiguous");
    expect(obsidian).not.toBeNull();
    expect(obsidian).toHaveProperty("current");
  });

  test("records literal markdown heading matching as a stripHeading divergence", () => {
    const cache = metadata([
      { heading: "**Bold** heading", level: 2, line: 1 },
    ]);

    // ADR-0024 §Consequences (Negative): real Obsidian applies stripHeading
    // normalisation. Its test mock intentionally does not, so comparing against
    // mocked resolveSubpath here would pin the mock instead of Obsidian's contract.
    expect(resolveShared(cache, "**Bold** heading", "::").kind).toBe("found");
    expect(resolveShared(cache, "Bold heading", "::").kind).toBe("not-found");
  });
});
