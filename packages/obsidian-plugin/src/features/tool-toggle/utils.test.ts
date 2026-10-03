import { describe, expect, test } from "bun:test";
import { TOOL_ANNOTATIONS } from "$/features/mcp-tools/toolAnnotations";
import { ALWAYS_ACTIVE_TOOLS } from "$/features/adaptive-tool-loading/constants";
import {
  DESTRUCTIVE_TOOL_NAMES,
  KNOWN_MCP_TOOL_NAMES,
  parseDisabledToolsCsv,
} from "./utils";

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
  test("is every annotated tool except the adaptive-loading meta-tools", () => {
    // The annotation table is the registry's shadow (the mcpServer
    // full-registry test fails when a tool is registered without an
    // entry), so deriving from it keeps the settings grid in step with
    // the server without a hand-maintained count.
    const expected = Object.keys(TOOL_ANNOTATIONS).filter(
      (name) => !ALWAYS_ACTIVE_TOOLS.includes(name),
    );
    expect([...KNOWN_MCP_TOOL_NAMES]).toEqual(expected);
    expect(KNOWN_MCP_TOOL_NAMES.length).toBeGreaterThanOrEqual(57);
    for (const meta of ALWAYS_ACTIVE_TOOLS) {
      expect(KNOWN_MCP_TOOL_NAMES).not.toContain(meta);
    }
  });

  test("has no duplicate entries", () => {
    expect(new Set(KNOWN_MCP_TOOL_NAMES).size).toBe(
      KNOWN_MCP_TOOL_NAMES.length,
    );
  });

  test("includes the expected critical tools", () => {
    // Spot-check a few well-known names that must never be renamed
    // without coordinating the annotation table with the server registry.
    expect(KNOWN_MCP_TOOL_NAMES).toContain("get_server_info");
    expect(KNOWN_MCP_TOOL_NAMES).toContain("patch_vault_file");
    expect(KNOWN_MCP_TOOL_NAMES).toContain("search_vault_smart");
    expect(KNOWN_MCP_TOOL_NAMES).toContain("execute_template");
    expect(KNOWN_MCP_TOOL_NAMES).toContain("fetch");
    expect(KNOWN_MCP_TOOL_NAMES).toContain("rename_tag");
    expect(KNOWN_MCP_TOOL_NAMES).toContain("delete_canvas_node");
  });
});

describe("DESTRUCTIVE_TOOL_NAMES", () => {
  test("is exactly the non-read-only subset of the toggleable tools", () => {
    for (const name of KNOWN_MCP_TOOL_NAMES) {
      const writer = TOOL_ANNOTATIONS[name]?.readOnlyHint !== true;
      expect(DESTRUCTIVE_TOOL_NAMES.includes(name), name).toBe(writer);
    }
  });

  test("covers additive writers as well as destructive ones", () => {
    // The preset promises a read-only surface, so SAFE_WRITE tools are in.
    expect(DESTRUCTIVE_TOOL_NAMES).toContain("append_to_vault_file");
    expect(DESTRUCTIVE_TOOL_NAMES).toContain("create_vault_directory");
    expect(DESTRUCTIVE_TOOL_NAMES).toContain("delete_vault_file");
    expect(DESTRUCTIVE_TOOL_NAMES).toContain("execute_obsidian_command");
  });

  test("leaves read-only tools alone", () => {
    expect(DESTRUCTIVE_TOOL_NAMES).not.toContain("get_vault_file");
    expect(DESTRUCTIVE_TOOL_NAMES).not.toContain("search_vault_simple");
    expect(DESTRUCTIVE_TOOL_NAMES).not.toContain("fetch");
    expect(DESTRUCTIVE_TOOL_NAMES).not.toContain("get_workspace_state");
  });
});
