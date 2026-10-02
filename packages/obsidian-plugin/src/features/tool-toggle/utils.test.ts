import { describe, expect, test } from "bun:test";
import { KNOWN_MCP_TOOL_NAMES, parseDisabledToolsCsv } from "./utils";

describe("parseDisabledToolsCsv", () => {
  test("returns an empty array for undefined, empty, or whitespace-only input", () => {
    expect(parseDisabledToolsCsv(undefined)).toEqual([]);
    expect(parseDisabledToolsCsv("")).toEqual([]);
    expect(parseDisabledToolsCsv("   ")).toEqual([]);
    expect(parseDisabledToolsCsv("\n\n")).toEqual([]);
  });

  test("splits on commas and trims whitespace around each entry", () => {
    expect(parseDisabledToolsCsv("a, b ,  c")).toEqual(["a", "b", "c"]);
  });

  test("splits on newlines as well as commas", () => {
    // Users may paste multi-line input; both separators are accepted.
    expect(parseDisabledToolsCsv("a\nb,c\n\n d ")).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  test("drops empty entries from double commas or trailing commas", () => {
    expect(parseDisabledToolsCsv("a,,b,")).toEqual(["a", "b"]);
    expect(parseDisabledToolsCsv(",a,b")).toEqual(["a", "b"]);
  });

  test("preserves duplicates — the server sees exactly what was typed", () => {
    // Stripping duplicates in the UI would hide typos from the user.
    // The server logs each name it tries to disable, so duplicates
    // are harmless and diagnostically useful.
    expect(parseDisabledToolsCsv("a, a, b")).toEqual(["a", "a", "b"]);
  });
});

describe("KNOWN_MCP_TOOL_NAMES", () => {
  test("contains exactly 20 tool names (matching the in-process registry)", () => {
    // 0.4.0: 20 tools, including list_obsidian_commands and
    // execute_obsidian_command (these were not exposed as MCP tools
    // in 0.3.x — issue #29 added them). If this number changes,
    // update both the list in utils.ts and the MCP surface section
    // in CLAUDE.md.
    expect(KNOWN_MCP_TOOL_NAMES.length).toBe(20);
  });

  test("has no duplicate entries", () => {
    expect(new Set(KNOWN_MCP_TOOL_NAMES).size).toBe(
      KNOWN_MCP_TOOL_NAMES.length,
    );
  });

  test("includes the expected critical tools", () => {
    // Spot-check a few well-known names that must never be renamed
    // without coordinating this list with the server registry.
    expect(KNOWN_MCP_TOOL_NAMES).toContain("get_server_info");
    expect(KNOWN_MCP_TOOL_NAMES).toContain("patch_vault_file");
    expect(KNOWN_MCP_TOOL_NAMES).toContain("search_vault_smart");
    expect(KNOWN_MCP_TOOL_NAMES).toContain("execute_template");
    expect(KNOWN_MCP_TOOL_NAMES).toContain("fetch");
  });
});
