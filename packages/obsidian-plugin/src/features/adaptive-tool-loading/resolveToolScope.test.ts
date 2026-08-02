import { describe, expect, test } from "bun:test";
import { isActiveFor, resolveToolScope } from "./resolveToolScope";
import type { TokenPolicy } from "./tokenPolicyStore";
import type { ToolScope } from "$/shared/types";
import { ALWAYS_ACTIVE_TOOLS, META_TOOLS } from "./constants";

const ALL_NAMES = [
  "get_server_info",
  "get_active_file",
  "update_active_file",
  "search_vault",
  "search_and_replace",
  "find_broken_links",
  "tool_catalog",
  "activate_tool",
  "activate_tools",
];

describe("resolveToolScope", () => {
  test("profile 'all' resolves to every name plus meta-tools", () => {
    const policy: TokenPolicy = { profile: "all", promoted: [], allowed: null };
    const scope = resolveToolScope("default", policy, ALL_NAMES, new Set());
    for (const n of ALL_NAMES) expect(scope.active.has(n)).toBe(true);
    for (const m of META_TOOLS) expect(scope.active.has(m)).toBe(true);
  });

  test("profile 'core' resolves to CORE_SET + promoted + meta-tools", () => {
    const policy: TokenPolicy = {
      profile: "core",
      promoted: ["search_and_replace"],
      allowed: null,
    };
    const scope = resolveToolScope("default", policy, ALL_NAMES, new Set());
    expect(scope.active.has("search_and_replace")).toBe(true); // explicit promotion
    expect(scope.active.has("find_broken_links")).toBe(false); // not core, not promoted
    expect(scope.active.has("get_active_file")).toBe(true); // CORE_SET member
    for (const m of ALWAYS_ACTIVE_TOOLS) expect(scope.active.has(m)).toBe(true);
  });

  test("allowed: null is identical to 0.28.2 profile filtering for the same profile (R-07)", () => {
    const policy: TokenPolicy = {
      profile: "core",
      promoted: ["search_and_replace"],
      allowed: null,
    };
    const scope = resolveToolScope("default", policy, ALL_NAMES, new Set());
    expect(scope.active.has("search_and_replace")).toBe(true);
    expect(scope.active.has("find_broken_links")).toBe(false);
    expect(scope.active.has("get_active_file")).toBe(true);
    for (const m of ALWAYS_ACTIVE_TOOLS) expect(scope.active.has(m)).toBe(true);
  });

  test("allowed: [...] intersects the active set; meta-tools still present", () => {
    const policy: TokenPolicy = {
      profile: "all",
      promoted: [],
      allowed: ["get_active_file"],
    };
    const scope = resolveToolScope("default", policy, ALL_NAMES, new Set());
    expect(scope.active.has("get_active_file")).toBe(true);
    expect(scope.active.has("search_vault")).toBe(false);
    for (const m of ALWAYS_ACTIVE_TOOLS) expect(scope.active.has(m)).toBe(true);
  });

  test("allowed: [] restricts the active set to meta-tools only", () => {
    const policy: TokenPolicy = { profile: "all", promoted: [], allowed: [] };
    const scope = resolveToolScope("default", policy, ALL_NAMES, new Set());
    for (const m of ALWAYS_ACTIVE_TOOLS) expect(scope.active.has(m)).toBe(true);
    expect(scope.active.has("get_active_file")).toBe(false);
    expect(scope.active.has("search_vault")).toBe(false);
  });

  test("an allowed entry naming an unregistered tool is ignored, not an error", () => {
    const policy: TokenPolicy = {
      profile: "all",
      promoted: [],
      allowed: ["get_active_file", "does_not_exist"],
    };
    expect(() =>
      resolveToolScope("default", policy, ALL_NAMES, new Set()),
    ).not.toThrow();
    const scope = resolveToolScope("default", policy, ALL_NAMES, new Set());
    expect(scope.active.has("get_active_file")).toBe(true);
    expect(scope.active.has("does_not_exist")).toBe(false);
  });

  test("session promotions union into promoted (R-03)", () => {
    const policy: TokenPolicy = {
      profile: "core",
      promoted: [],
      allowed: null,
    };
    const session = new Set(["search_and_replace"]);
    const scope = resolveToolScope("default", policy, ALL_NAMES, session);
    expect(scope.active.has("search_and_replace")).toBe(true);
  });

  test("carries the caller's opaque id", () => {
    const policy: TokenPolicy = { profile: "all", promoted: [], allowed: null };
    const scope = resolveToolScope("claude", policy, ALL_NAMES, new Set());
    expect(scope.id).toBe("claude");
  });
});

describe("isActiveFor", () => {
  const scope: ToolScope = {
    id: "claude",
    active: new Set(["search_vault"]),
    allowed: null,
  };

  test("under a scope, both halves must hold", () => {
    expect(isActiveFor(true, "search_vault", scope)).toBe(true);
    // Served, but outside this caller's set.
    expect(isActiveFor(true, "find_broken_links", scope)).toBe(false);
    // In the caller's set, but the registry is not serving it — the case
    // toolCatalog.ts got wrong while it kept its own copy of this rule.
    expect(isActiveFor(false, "search_vault", scope)).toBe(false);
  });

  test("without a scope it is the registry's answer alone", () => {
    expect(isActiveFor(true, "search_vault")).toBe(true);
    expect(isActiveFor(false, "search_vault")).toBe(false);
  });

  test("an empty active set makes every tool inactive for that caller", () => {
    const locked: ToolScope = { id: "x", active: new Set(), allowed: null };
    for (const name of ALL_NAMES) {
      expect(isActiveFor(true, name, locked)).toBe(false);
    }
  });
});
