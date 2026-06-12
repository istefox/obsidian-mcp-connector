import { describe, expect, test, spyOn } from "bun:test";
import { type } from "arktype";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "$/shared/logger";
import { normalizeInputSchema, ToolRegistryClass } from "./toolRegistry";

/**
 * Minimal fake MCP Server context, just enough to satisfy the handler
 * signature. We never hit the network or the real SDK in these tests.
 */
const fakeContext = { server: {} as never };

/**
 * Build a `ToolRegistryClass` prepopulated with two no-op tools. Used
 * by the disable/dispatch tests below to avoid repeating boilerplate.
 */
function buildRegistryWithTwoTools() {
  const tools = new ToolRegistryClass();

  const alphaSchema = type({
    name: '"alpha"',
    arguments: {},
  }).describe("Alpha tool");

  const betaSchema = type({
    name: '"beta"',
    arguments: {},
  }).describe("Beta tool");

  tools.register(alphaSchema, () => ({
    content: [{ type: "text", text: "alpha-ok" }],
  }));
  tools.register(betaSchema, () => ({
    content: [{ type: "text", text: "beta-ok" }],
  }));

  return { tools, alphaSchema, betaSchema };
}

describe("normalizeInputSchema", () => {
  test("adds missing properties key to an otherwise valid object schema", () => {
    const input = { type: "object", additionalProperties: true };
    const out = normalizeInputSchema(input);
    expect(out).toEqual({
      type: "object",
      additionalProperties: true,
      properties: {},
    });
  });

  test("preserves an existing properties key unchanged", () => {
    const input = {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    };
    const out = normalizeInputSchema(input);
    expect(out.properties).toEqual({ query: { type: "string" } });
    expect(out.required).toEqual(["query"]);
  });

  test("adds both type and properties when the input is a bare empty object", () => {
    // This is the scenario ArkType produces for `arguments: {}`:
    // its JSON schema output is already well-formed, but this test
    // verifies the wrapper does not regress when given a minimal shape.
    const input = {};
    const out = normalizeInputSchema(input);
    expect(out.type).toBe("object");
    expect(out.properties).toEqual({});
  });

  test("does not mutate the input object", () => {
    const input: Record<string, unknown> = { type: "object" };
    normalizeInputSchema(input);
    expect(input).toEqual({ type: "object" });
    expect("properties" in input).toBe(false);
  });

  test("falls back to a valid empty schema when input is null", () => {
    // Defensive guard: if something returns null from toJsonSchema()
    // we still want a protocol-valid schema, not a crash.
    const out = normalizeInputSchema(null);
    expect(out.type).toBe("object");
    expect(out.properties).toEqual({});
  });

  test("falls back to a valid empty schema when input is a primitive", () => {
    const out = normalizeInputSchema("not an object" as unknown);
    expect(out.type).toBe("object");
    expect(out.properties).toEqual({});
  });

  test("leaves an existing type key untouched even if not 'object'", () => {
    // Pathological but preserved: if something upstream explicitly
    // marks a schema as non-object, we log the caller's intent.
    // (In practice MCP will reject this at the protocol level, but
    // normalizeInputSchema is not the right place to enforce it.)
    const input = { type: "string" };
    const out = normalizeInputSchema(input);
    expect(out.type).toBe("string");
    expect(out.properties).toEqual({});
  });

  test("strips additionalProperties: {} (empty-object form) — issue #63", () => {
    // Letta Cloud rejects `additionalProperties: {}` with a 500; the
    // empty-object form is semantically the same as `true` but not
    // spec-valid for strict validators. We drop it so the schema is
    // interpreted as "no constraint on extras" by default.
    const input = {
      type: "object",
      properties: {},
      additionalProperties: {},
    };
    const out = normalizeInputSchema(input);
    expect(out).toEqual({ type: "object", properties: {} });
    expect("additionalProperties" in out).toBe(false);
  });

  test("preserves additionalProperties: true", () => {
    const input = {
      type: "object",
      properties: {},
      additionalProperties: true,
    };
    const out = normalizeInputSchema(input);
    expect(out.additionalProperties).toBe(true);
  });

  test("preserves additionalProperties: false", () => {
    const input = {
      type: "object",
      properties: {},
      additionalProperties: false,
    };
    const out = normalizeInputSchema(input);
    expect(out.additionalProperties).toBe(false);
  });

  test("preserves a non-empty additionalProperties sub-schema", () => {
    // A real sub-schema (anything with at least one key) is passed
    // through — we only strip the semantically-empty object form.
    const input = {
      type: "object",
      properties: {},
      additionalProperties: { type: "string" },
    };
    const out = normalizeInputSchema(input);
    expect(out.additionalProperties).toEqual({ type: "string" });
  });

  test("strips anyOf member descriptions duplicating the parent's", () => {
    // ArkType propagates a union's .describe() onto every branch; the
    // wire format only needs the property-level copy.
    const desc = "Period granularity.";
    const input = {
      type: "object",
      properties: {
        period: {
          description: desc,
          anyOf: [
            { const: "daily", description: desc },
            { const: "weekly", description: desc },
          ],
        },
      },
    };
    const out = normalizeInputSchema(input) as {
      properties: {
        period: { description: string; anyOf: Record<string, unknown>[] };
      };
    };
    expect(out.properties.period.description).toBe(desc);
    for (const member of out.properties.period.anyOf) {
      expect("description" in member).toBe(false);
    }
  });

  test("hoists a description shared by all anyOf members when the parent has none", () => {
    const desc = "Value to set.";
    const input = {
      type: "object",
      properties: {
        value: {
          anyOf: [
            { type: "string", description: desc },
            { type: "number", description: desc },
          ],
        },
      },
    };
    const out = normalizeInputSchema(input) as {
      properties: {
        value: { description: string; anyOf: Record<string, unknown>[] };
      };
    };
    expect(out.properties.value.description).toBe(desc);
    for (const member of out.properties.value.anyOf) {
      expect("description" in member).toBe(false);
    }
  });

  test("preserves anyOf member descriptions that genuinely differ", () => {
    const input = {
      type: "object",
      properties: {
        mode: {
          anyOf: [
            { const: "a", description: "First mode." },
            { const: "b", description: "Second mode." },
          ],
        },
      },
    };
    const out = normalizeInputSchema(input) as {
      properties: { mode: { anyOf: { description: string }[] } };
    };
    expect(out.properties.mode.anyOf[0].description).toBe("First mode.");
    expect(out.properties.mode.anyOf[1].description).toBe("Second mode.");
  });

  test("dedupe does not mutate the input object", () => {
    const desc = "Shared description.";
    const input = {
      type: "object",
      properties: {
        period: {
          description: desc,
          anyOf: [{ const: "daily", description: desc }],
        },
      },
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    normalizeInputSchema(input);
    expect(input).toEqual(snapshot);
  });
});

describe("ToolRegistry list() — issue #77 regression", () => {
  test("every tool's inputSchema carries an explicit `properties` key, even no-arg tools", () => {
    // Upstream issue #77 (filed 2026-04-13): strict MCP clients like
    // openai-codex reject a tool whose inputSchema is `{ type: "object" }`
    // without a `properties` field. The fix lives in normalizeInputSchema,
    // which is invoked by ToolRegistry.list() for every tool. This test
    // exercises the integrated path so we catch any regression where the
    // wrapper is bypassed (e.g. a future refactor that emits the schema
    // directly from arktype's toJsonSchema()).
    const { tools } = buildRegistryWithTwoTools();

    const listed = tools.list().tools;
    expect(listed.length).toBeGreaterThan(0);

    for (const tool of listed) {
      const schema = tool.inputSchema;
      expect(schema.type).toBe("object");
      expect(schema).toHaveProperty("properties");
      // The shape doesn't matter (could be `{}` for no-arg tools, or a
      // populated record for tools with arguments) — the only invariant
      // we enforce here is that the key is PRESENT.
      expect(typeof schema.properties).toBe("object");
    }
  });
});

describe("ToolRegistry enable/disable", () => {
  test("list() hides a disabled tool", () => {
    const { tools, alphaSchema } = buildRegistryWithTwoTools();

    // Baseline: both tools are enabled.
    expect(tools.list().tools.map((t) => t.name)).toEqual(["alpha", "beta"]);

    tools.disable(alphaSchema);

    expect(tools.list().tools.map((t) => t.name)).toEqual(["beta"]);
  });

  test("dispatch() on a disabled tool returns isError: true with Unknown tool message", async () => {
    const { tools, alphaSchema } = buildRegistryWithTwoTools();

    tools.disable(alphaSchema);

    // A disabled tool must be indistinguishable from an unregistered
    // one — otherwise `list()` and `dispatch()` would disagree.
    //
    // After issue #74, the registry no longer throws the McpError up to
    // the transport layer (which would cause downstream clients to
    // double-prefix the message); it surfaces the error via the MCP
    // `isError: true` envelope. The semantic distinction is the same —
    // the caller learns the tool is not available — but the wire format
    // is the cleaner single-prefix one.
    const result = (await tools.dispatch(
      { name: "alpha", arguments: {} },
      fakeContext,
    )) as { content: Array<{ type: "text"; text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Unknown tool: alpha/);
  });

  test("dispatch() still works for other enabled tools after one is disabled", async () => {
    const { tools, alphaSchema } = buildRegistryWithTwoTools();

    tools.disable(alphaSchema);

    const result = await tools.dispatch(
      { name: "beta", arguments: {} },
      fakeContext,
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "beta-ok" }],
    });
  });

  test("disableByName returns true for a known tool and disables it", () => {
    const { tools } = buildRegistryWithTwoTools();

    const result = tools.disableByName("alpha");

    expect(result).toBe(true);
    expect(tools.list().tools.map((t) => t.name)).toEqual(["beta"]);
  });

  test("disableByName returns false for an unknown tool and is a no-op", () => {
    const { tools } = buildRegistryWithTwoTools();

    const result = tools.disableByName("nonexistent");

    expect(result).toBe(false);
    // Both tools still listed.
    expect(tools.list().tools.map((t) => t.name)).toEqual(["alpha", "beta"]);
  });
});

/**
 * Issue #74 — registry-level isError envelope for thrown errors.
 *
 * Background: in PR #69 the `executeTemplate.ts` handler was changed to
 * return `{ content, isError: true }` instead of throwing McpError, to
 * avoid the cosmetic `MCP error -<code>: MCP error -<code>: <text>`
 * double-prefix that downstream MCP clients (mcp-remote bridging
 * stdio↔HTTP) prepend to thrown McpErrors. That fix was local to one
 * handler. Folotp's 0.4.0-beta.2 retest (issue #74) showed the same
 * double-prefix is still visible on every other tool that throws —
 * `patch_vault_file`, `patch_active_file`, etc.
 *
 * Fix: hoist the same `isError: true` pattern up to the `dispatch()`
 * catch in `ToolRegistry`, so it applies uniformly to every tool that
 * throws. The handler-side fix in `executeTemplate.ts` becomes a
 * defence-in-depth safety net (kept for explicit clarity).
 */
describe("ToolRegistry — issue #74 (registry-level isError envelope)", () => {
  test("handler throwing McpError surfaces as isError: true with the original message", async () => {
    const tools = new ToolRegistryClass();
    const schema = type({
      name: '"throwing-tool"',
      arguments: {},
    }).describe("Tool that throws an McpError");

    tools.register(schema, () => {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Refusing to overwrite array with scalar",
      );
    });

    const result = (await tools.dispatch(
      { name: "throwing-tool", arguments: {} },
      fakeContext,
    )) as { content: Array<{ type: "text"; text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      "MCP error -32602: Refusing to overwrite array with scalar",
    );
    // Crucially: NOT the double-prefixed form (`MCP error -32602: MCP error -32602: ...`).
    expect(result.content[0]?.text).not.toMatch(
      /MCP error -\d+:\s+MCP error -\d+:/,
    );
  });

  test("handler throwing a plain Error is wrapped to InternalError and surfaced as isError: true", async () => {
    const tools = new ToolRegistryClass();
    const schema = type({
      name: '"plain-throw"',
      arguments: {},
    }).describe("Tool that throws a plain Error");

    tools.register(schema, () => {
      throw new Error("Templater rendering exploded");
    });

    const result = (await tools.dispatch(
      { name: "plain-throw", arguments: {} },
      fakeContext,
    )) as { content: Array<{ type: "text"; text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Templater rendering exploded");
    // formatMcpError wraps plain Error as InternalError (-32603)
    expect(result.content[0]?.text).toMatch(/^MCP error -32603:/);
    // No double-prefix
    expect(result.content[0]?.text).not.toMatch(
      /MCP error -\d+:\s+MCP error -\d+:/,
    );
  });

  test("handler returning normally is unaffected (success path is not wrapped as isError)", async () => {
    const { tools } = buildRegistryWithTwoTools();

    const result = await tools.dispatch(
      { name: "alpha", arguments: {} },
      fakeContext,
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "alpha-ok" }],
    });
    // The success path did not gain a spurious isError flag.
    expect((result as { isError?: boolean }).isError).toBeUndefined();
  });

  test("handler returning isError: true normally (e.g. executeTemplate.ts pattern) is passed through unchanged", async () => {
    const tools = new ToolRegistryClass();
    const schema = type({
      name: '"already-isError"',
      arguments: {},
    }).describe("Tool that returns isError: true without throwing");

    tools.register(schema, () => ({
      content: [{ type: "text", text: "Template not found: foo.md" }],
      isError: true,
    }));

    const result = (await tools.dispatch(
      { name: "already-isError", arguments: {} },
      fakeContext,
    )) as { content: Array<{ type: "text"; text: string }>; isError?: boolean };

    // Handler-side isError envelope is forwarded byte-for-byte.
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Template not found: foo.md");
  });
});

describe("ToolRegistry — tool-error log redaction", () => {
  test("error log carries the tool name but never params.arguments", async () => {
    const tools = new ToolRegistryClass();
    const schema = type({
      name: '"redact-me"',
      arguments: { secret: "string" },
    }).describe("Tool that throws so the error path logs");

    tools.register(schema, () => {
      throw new McpError(ErrorCode.InternalError, "boom");
    });

    const calls: Array<[unknown, unknown]> = [];
    const spy = spyOn(logger, "error").mockImplementation(
      (msg: unknown, meta?: unknown) => {
        calls.push([msg, meta]);
      },
    );

    try {
      await tools.dispatch(
        // The argument value is sensitive user data; it must not be logged.
        { name: "redact-me", arguments: { secret: "private-note-body" } },
        fakeContext,
      );
    } finally {
      spy.mockRestore();
    }

    expect(calls.length).toBe(1);
    const meta = calls[0]?.[1] as Record<string, unknown>;
    expect(meta.tool).toBe("redact-me");
    expect("params" in meta).toBe(false);
    // No serialized form of the meta object may leak the argument value.
    expect(JSON.stringify(meta)).not.toContain("private-note-body");
  });
});

describe("ToolRegistry list() memoization", () => {
  test("repeated list() calls return the same object until enable/disable", () => {
    const { tools, alphaSchema } = buildRegistryWithTwoTools();

    const first = tools.list();
    expect(tools.list()).toBe(first);

    tools.disable(alphaSchema);
    const afterDisable = tools.list();
    expect(afterDisable).not.toBe(first);
    expect(afterDisable.tools.map((t) => t.name)).toEqual(["beta"]);
    expect(tools.list()).toBe(afterDisable);

    tools.enable(alphaSchema);
    const afterEnable = tools.list();
    expect(afterEnable).not.toBe(afterDisable);
    // Re-enabling appends to the Set, so alpha moves to the end.
    expect(afterEnable.tools.map((t) => t.name)).toEqual(["beta", "alpha"]);
  });

  test("enableByName/disableByName also invalidate the cache", () => {
    const { tools } = buildRegistryWithTwoTools();

    const first = tools.list();
    tools.disableByName("beta");
    expect(tools.list().tools.map((t) => t.name)).toEqual(["alpha"]);
    expect(tools.list()).not.toBe(first);
  });
});
