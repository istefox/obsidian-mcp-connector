import { describe, expect, test } from "bun:test";
import { MIN_NODE_VERSION, parseArgs, unsupportedNodeReason } from "./args";

describe("unsupportedNodeReason", () => {
  test("accepts the first Node 24 LTS and anything newer", () => {
    for (const v of [
      MIN_NODE_VERSION,
      "24.11.1",
      "24.22.0",
      "25.0.0",
      "26.1.0",
    ])
      expect(unsupportedNodeReason(v)).toBeUndefined();
  });

  test("refuses older releases with the version it found", () => {
    for (const v of ["24.10.9", "24.0.0", "22.20.0", "20.19.5"])
      expect(unsupportedNodeReason(v)).toContain(`found ${v}`);
  });
});

describe("parseArgs", () => {
  test("a positional vault selects stdio", () => {
    expect(parseArgs(["/v"], {})).toEqual({
      kind: "run",
      vault: "/v",
      http: false,
      port: undefined,
      data: undefined,
      printToken: false,
    });
  });

  test("falls back to OBSIDIAN_VAULT", () => {
    const parsed = parseArgs([], { OBSIDIAN_VAULT: "/env" });
    expect(parsed.kind === "run" && parsed.vault).toBe("/env");
  });

  test("the argument wins over the environment", () => {
    const parsed = parseArgs(["/arg"], { OBSIDIAN_VAULT: "/env" });
    expect(parsed.kind === "run" && parsed.vault).toBe("/arg");
  });

  test("no vault is a usage error", () => {
    const parsed = parseArgs([], {});
    expect(parsed.kind === "error" && parsed.message).toContain("Usage");
  });

  test("parses the HTTP options", () => {
    const parsed = parseArgs(
      ["/v", "--http", "--port", "28000", "--data", "/s.json", "--print-token"],
      {},
    );
    expect(parsed).toMatchObject({
      kind: "run",
      http: true,
      port: 28000,
      data: "/s.json",
      printToken: true,
    });
  });

  test.each([
    [["/v", "--port", "80", "--http"]],
    [["/v", "--port", "x", "--http"]],
    [["/v", "--port", "65536", "--http"]],
    [["/v", "--port", "28000.5", "--http"]],
    [["/v", "--http", "--port"]],
    [["/v", "--port", "28000"]],
    [["/v", "--print-token"]],
    [["/v", "--bogus"]],
    [["/a", "/b"]],
  ])("rejects %p", (argv) => {
    expect(parseArgs(argv, {}).kind).toBe("error");
  });

  test.each([["1024"], ["65535"]])("accepts port %p at the range edge", (p) => {
    const parsed = parseArgs(["/v", "--http", "--port", p], {});
    expect(parsed.kind === "run" && parsed.port).toBe(Number(p));
  });

  test("--help wins", () => {
    expect(parseArgs(["--help"], {}).kind).toBe("help");
  });
});
