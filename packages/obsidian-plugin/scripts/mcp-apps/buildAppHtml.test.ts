import { describe, expect, test } from "bun:test";
import { BUNDLE_MARKER, buildSearchResultsHtml } from "./buildAppHtml";

const SHELL = `<html>${BUNDLE_MARKER}</html>`;

describe("buildSearchResultsHtml", () => {
  test("splices the bundle into the shell at the marker", () => {
    expect(buildSearchResultsHtml(SHELL, "const x = 1;")).toBe(
      "<html>const x = 1;</html>",
    );
  });

  test("splices a bundle containing quotes and backticks but no </script sequence", () => {
    const bundle = 'const s = `a "quoted" ${template}`;';
    expect(buildSearchResultsHtml(SHELL, bundle)).toBe(
      `<html>${bundle}</html>`,
    );
  });

  test("splices a bundle containing $& and $1 verbatim, not as replacement-pattern references", () => {
    // String.prototype.replace's replacement-string argument treats $&,
    // $`, $' and $<n> as pattern references. A minified bundle can contain
    // any of these by accident; split/join must carry them through as
    // plain text instead of substituting on them.
    const bundle = 'const re = /(a)/; "x".replace(re, "$& $1 $` $\' end");';
    expect(buildSearchResultsHtml(SHELL, bundle)).toBe(
      `<html>${bundle}</html>`,
    );
  });

  // Unreachable with the currently pinned ext-apps@1.7.5 bundle (ADR-0018
  // records it contains no "</script" sequence) — this is the guard for
  // whatever a future 1.7.6 ships.
  test("throws when the bundle contains a </script sequence, naming the offending index", () => {
    const bundle = "before</script>after";
    expect(() => buildSearchResultsHtml(SHELL, bundle)).toThrow(/<\/script/);
    expect(() => buildSearchResultsHtml(SHELL, bundle)).toThrow(
      String(bundle.indexOf("</script")),
    );
  });

  test("throws on a case-insensitive match, e.g. </SCRIPT>", () => {
    const bundle = "before</SCRIPT>after";
    expect(() => buildSearchResultsHtml(SHELL, bundle)).toThrow(/<\/script/i);
  });

  test("throws on a bundle that only contains an unclosed </script tag fragment", () => {
    const bundle = "trailing </script";
    expect(() => buildSearchResultsHtml(SHELL, bundle)).toThrow(
      String(bundle.indexOf("</script")),
    );
  });
});
