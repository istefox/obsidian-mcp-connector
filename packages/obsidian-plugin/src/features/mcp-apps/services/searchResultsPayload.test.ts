import { describe, expect, test } from "bun:test";
import {
  SEARCH_RESULTS_PAYLOAD_KEY,
  SEARCH_RESULTS_ROW_CAP,
  SEARCH_RESULTS_EXCERPT_CLIP,
  projectSimpleSearchResults,
  projectSmartSearchResults,
  withSearchResultsPayload,
} from "./searchResultsPayload";

describe("search results payload — naming (ADR-0018 D6)", () => {
  test("payload key, row cap and excerpt clip match the values fixed in the plan", () => {
    expect(SEARCH_RESULTS_PAYLOAD_KEY).toBe(
      "io.github.istefox.mcp-connector/searchResults",
    );
    expect(SEARCH_RESULTS_ROW_CAP).toBe(50);
    expect(SEARCH_RESULTS_EXCERPT_CLIP).toBe(400);
  });
});

describe("projectSimpleSearchResults — flattens file × match into rows", () => {
  test("filePath comes from filename, excerpt from context, line is kept, score and heading are omitted", () => {
    const payload = projectSimpleSearchResults(
      [
        {
          filename: "notes/alpha.md",
          matches: [
            { context: "before HIT after", line: 4 },
            { context: "second HIT here", line: 9 },
          ],
        },
        {
          filename: "notes/beta.md",
          matches: [{ context: "one more HIT", line: 0 }],
        },
      ],
      "Test Vault",
    );

    expect(payload.vaultName).toBe("Test Vault");
    expect(payload.totalRows).toBe(3);
    expect(payload.truncated).toBe(false);
    expect(payload.rows).toEqual([
      {
        filePath: "notes/alpha.md",
        excerpt: "before HIT after",
        line: 4,
        score: null,
        heading: null,
      },
      {
        filePath: "notes/alpha.md",
        excerpt: "second HIT here",
        line: 9,
        score: null,
        heading: null,
      },
      {
        filePath: "notes/beta.md",
        excerpt: "one more HIT",
        line: 0,
        score: null,
        heading: null,
      },
    ]);
  });

  test("a file with no matches contributes no rows", () => {
    const payload = projectSimpleSearchResults(
      [{ filename: "notes/empty.md", matches: [] }],
      "Test Vault",
    );
    expect(payload.rows).toEqual([]);
    expect(payload.totalRows).toBe(0);
  });

  test("zero files survive as a zero-row payload, not a thrown error", () => {
    const payload = projectSimpleSearchResults([], "Test Vault");
    expect(payload).toEqual({
      vaultName: "Test Vault",
      totalRows: 0,
      truncated: false,
      rows: [],
    });
  });

  test("200 rows cap at 50 with truncated true and totalRows 200", () => {
    const files = Array.from({ length: 200 }, (_, i) => ({
      filename: `notes/f${i}.md`,
      matches: [{ context: `hit ${i}`, line: 0 }],
    }));
    const payload = projectSimpleSearchResults(files, "Test Vault");
    expect(payload.totalRows).toBe(200);
    expect(payload.truncated).toBe(true);
    expect(payload.rows).toHaveLength(50);
    // The cap keeps the leading rows in source order rather than
    // dropping from the front or sampling.
    expect(payload.rows[0]?.filePath).toBe("notes/f0.md");
    expect(payload.rows[49]?.filePath).toBe("notes/f49.md");
  });

  test("an excerpt over 400 characters is clipped to exactly 400", () => {
    const longContext = "x".repeat(450);
    const payload = projectSimpleSearchResults(
      [
        {
          filename: "notes/long.md",
          matches: [{ context: longContext, line: 0 }],
        },
      ],
      "Test Vault",
    );
    expect(payload.rows[0]?.excerpt).toHaveLength(400);
    expect(payload.rows[0]?.excerpt).toBe(longContext.slice(0, 400));
  });
});

describe("projectSmartSearchResults — maps SearchResult field for field", () => {
  test("filePath, excerpt, line, score and heading all pass through unchanged", () => {
    const payload = projectSmartSearchResults(
      [
        {
          filePath: "Notes/ml.md",
          heading: "ML Notes",
          excerpt: "ML Notes: introduction to gradient descent.",
          line: 3,
          score: 0.91,
        },
      ],
      "Test Vault",
    );
    expect(payload.rows).toEqual([
      {
        filePath: "Notes/ml.md",
        excerpt: "ML Notes: introduction to gradient descent.",
        line: 3,
        score: 0.91,
        heading: "ML Notes",
      },
    ]);
  });

  test("line: null survives — normal under Smart Connections, which cannot resolve one", () => {
    const payload = projectSmartSearchResults(
      [
        {
          filePath: "Notes/dl.md",
          heading: null,
          excerpt: "Deep learning summary.",
          line: null,
          score: 0.84,
        },
      ],
      "Test Vault",
    );
    expect(payload.rows[0]?.line).toBeNull();
  });

  test("zero results survive as a zero-row payload, not a thrown error", () => {
    const payload = projectSmartSearchResults([], "Test Vault");
    expect(payload).toEqual({
      vaultName: "Test Vault",
      totalRows: 0,
      truncated: false,
      rows: [],
    });
  });

  test("200 rows cap at 50 with truncated true and totalRows 200", () => {
    const results = Array.from({ length: 200 }, (_, i) => ({
      filePath: `Notes/f${i}.md`,
      heading: null,
      excerpt: `hit ${i}`,
      line: null,
      score: 1 - i / 1000,
    }));
    const payload = projectSmartSearchResults(results, "Test Vault");
    expect(payload.totalRows).toBe(200);
    expect(payload.truncated).toBe(true);
    expect(payload.rows).toHaveLength(50);
    expect(payload.rows[0]?.filePath).toBe("Notes/f0.md");
    expect(payload.rows[49]?.filePath).toBe("Notes/f49.md");
  });

  test("an excerpt over 400 characters is clipped to exactly 400", () => {
    const longExcerpt = "y".repeat(500);
    const payload = projectSmartSearchResults(
      [
        {
          filePath: "Notes/long.md",
          heading: null,
          excerpt: longExcerpt,
          line: null,
          score: 0.5,
        },
      ],
      "Test Vault",
    );
    expect(payload.rows[0]?.excerpt).toHaveLength(400);
    expect(payload.rows[0]?.excerpt).toBe(longExcerpt.slice(0, 400));
  });
});

describe("withSearchResultsPayload — success branch carries the payload, isError branch is a no-op (ADR-0018 D5)", () => {
  const payload = {
    vaultName: "Test Vault",
    totalRows: 1,
    truncated: false,
    rows: [
      {
        filePath: "notes/alpha.md",
        excerpt: "hit",
        line: 0,
        score: null,
        heading: null,
      },
    ],
  };

  test("a success result gains _meta under the fixed key, content untouched", () => {
    const result = {
      content: [{ type: "text" as const, text: '{"results":[]}' }],
    };
    const wrapped = withSearchResultsPayload(result, payload);
    expect(wrapped.content).toEqual(result.content);
    expect(wrapped.isError).toBeUndefined();
    expect(
      (wrapped as { _meta?: Record<string, unknown> })._meta?.[
        SEARCH_RESULTS_PAYLOAD_KEY
      ],
    ).toEqual(payload);
  });

  test("an existing _meta key on the result survives alongside the new one", () => {
    const result = {
      content: [{ type: "text" as const, text: "{}" }],
      _meta: { "some.other/key": "kept" },
    };
    const wrapped = withSearchResultsPayload(result, payload);
    expect((wrapped as { _meta?: Record<string, unknown> })._meta).toEqual({
      "some.other/key": "kept",
      [SEARCH_RESULTS_PAYLOAD_KEY]: payload,
    });
  });

  test("an isError result is returned unchanged — no _meta key is added", () => {
    const errorResult = {
      content: [{ type: "text" as const, text: "index still building" }],
      isError: true as const,
    };
    const wrapped = withSearchResultsPayload(errorResult, payload);
    expect(wrapped).toEqual(errorResult);
    expect(
      (wrapped as { _meta?: Record<string, unknown> })._meta?.[
        SEARCH_RESULTS_PAYLOAD_KEY
      ],
    ).toBeUndefined();
  });
});
