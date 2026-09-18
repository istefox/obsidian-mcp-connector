import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { BUNDLE_MARKER } from "../../../../scripts/mcp-apps/buildAppHtml";
import { SEARCH_RESULTS_PAYLOAD_KEY } from "../services/searchResultsPayload";
import { SEARCH_RESULTS_APP_HTML as html } from "./searchResultsAppSource";

// The generated page is compiler output, so its exact bytes move with the
// Bun version that built it. These checks assert what must hold on any Bun
// (the CSP-relevant shape of the page, and that the hand-written shell was
// regenerated) and leave behaviour to the DOM test and the browser test.

const shell = readFileSync(
  join(import.meta.dir, "../../../../assets/mcp-apps/searchResults.html"),
  "utf8",
);

function moduleScripts(page: string): RegExpMatchArray[] {
  return [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
}

describe("generated search-results page (issue #538)", () => {
  test("loads no code at runtime: no Blob URL, no dynamic import, no external script", () => {
    expect(html).not.toContain("createObjectURL");
    // As a URL scheme in a string, not the `blob` key of the SDK's schemas.
    expect(html).not.toMatch(/["'`]blob:/);
    expect(html).not.toMatch(/\bimport\s*\(/);
    expect(html).not.toMatch(/<script[^>]*\ssrc\s*=/i);
    expect(html).not.toMatch(/\beval\s*\(|new\s+Function\s*\(/);
  });

  test("has exactly one script element, an inline module", () => {
    const scripts = moduleScripts(html);
    expect(scripts).toHaveLength(1);
    expect(scripts[0][1]).toMatch(/type\s*=\s*"module"/);
    expect(scripts[0][2].length).toBeGreaterThan(10_000);
    expect(html.match(/<\/script/gi)).toHaveLength(1);
  });

  test("has no static import left in the module: the SDK is compiled in", () => {
    const body = moduleScripts(html)[0][2];
    expect(body).not.toMatch(/(^|[;}])\s*import\s*[\w{*"']/);
  });

  test("everything outside the module script is the shell, so a shell edit needs a regeneration", () => {
    const body = moduleScripts(html)[0][2];
    expect(html.split(body).join(BUNDLE_MARKER)).toBe(shell);
  });

  test("the view's payload key is the server's", () => {
    expect(html).toContain(SEARCH_RESULTS_PAYLOAD_KEY);
  });
});
