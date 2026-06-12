import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  McpError,
  type Result,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { type, type Type } from "arktype";
import { formatMcpError } from "./formatMcpError";
import { logger } from "$/shared";

interface HandlerContext {
  server: McpServer;
}

/**
 * Ensure an MCP tool's `inputSchema` always carries an explicit
 * `properties` key (even when empty) and a well-formed
 * `additionalProperties` value. Some non-Claude MCP clients —
 * notably Letta Cloud and several OpenAI-compatible bridges — reject
 * tool schemas that omit `properties`, or that set
 * `additionalProperties: {}` (an empty-object schema, semantically
 * equivalent to `true` but not accepted by strict validators).
 *
 * This is defense in depth on top of the per-feature fix of using
 * empty-object literals instead of `Record<string, unknown>`: if a
 * future contributor reintroduces an open-record argument schema,
 * the wrapper still yields a well-formed output for strict clients.
 *
 * Exported so it can be unit-tested without instantiating the whole
 * ToolRegistry.
 *
 * See issues #63 (Letta Cloud) and #77 (openai-codex).
 */
/**
 * ArkType propagates a union's `.describe()` text onto every branch, so
 * the generated JSON Schema carries the same description once per
 * `anyOf` member on top of the property-level copy — a 5-way enum pays
 * for its description six times. Strip member descriptions that
 * duplicate the parent's, and hoist a description shared by every
 * member when the parent has none. Wire-size optimization only
 * (~19% of tools/list bytes measured at 0.15.6); no semantic change.
 */
function dedupeUnionDescriptions(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) dedupeUnionDescriptions(item);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const obj = node as Record<string, unknown>;

  if (Array.isArray(obj.anyOf)) {
    const members = obj.anyOf.filter(
      (m): m is Record<string, unknown> => typeof m === "object" && m !== null,
    );
    if (typeof obj.description === "string") {
      for (const m of members) {
        if (m.description === obj.description) delete m.description;
      }
    } else {
      const descriptions = new Set(members.map((m) => m.description));
      if (descriptions.size === 1) {
        const [shared] = descriptions;
        if (typeof shared === "string") {
          obj.description = shared;
          for (const m of members) delete m.description;
        }
      }
    }
  }

  for (const value of Object.values(obj)) dedupeUnionDescriptions(value);
}

export function normalizeInputSchema(
  jsonSchema: unknown,
): Record<string, unknown> {
  // Accept any JSON-schema-shaped value; fall back to an empty object
  // schema if the input is somehow not an object (should not happen
  // with ArkType, but we refuse to crash on malformed data).
  const base =
    typeof jsonSchema === "object" && jsonSchema !== null
      ? (jsonSchema as Record<string, unknown>)
      : { type: "object" };

  // Deep clone: dedupeUnionDescriptions mutates nested nodes, and the
  // caller's object must stay untouched.
  const result: Record<string, unknown> = structuredClone(base);

  dedupeUnionDescriptions(result);

  // Force-set `type: "object"` if missing — MCP inputSchema must be an
  // object type by protocol.
  if (!("type" in result)) {
    result.type = "object";
  }

  // Guarantee `properties` is present, defaulting to an empty object
  // for no-arg tools (issue #77).
  if (!("properties" in result)) {
    result.properties = {};
  }

  // Strip `additionalProperties: {}` — an empty-object schema is
  // semantically equivalent to `additionalProperties: true` but is
  // rejected by strict validators such as Letta Cloud (issue #63).
  // `true`, `false`, and genuine sub-schemas are left untouched.
  const ap = result.additionalProperties;
  if (
    ap !== undefined &&
    typeof ap === "object" &&
    ap !== null &&
    Object.keys(ap as Record<string, unknown>).length === 0
  ) {
    delete result.additionalProperties;
  }

  return result;
}

const textResult = type({
  type: '"text"',
  text: "string",
});
const imageResult = type({
  type: '"image"',
  data: "string.base64",
  mimeType: "string",
});
// Audio content block — added alongside image for MCP SDK 1.29.0's
// native audio support (used by `get_vault_file` to stream audio bytes
// without base64-ifying them into text). See issue #59.
const audioResult = type({
  type: '"audio"',
  data: "string.base64",
  mimeType: "string",
});
export const resultSchema = type({
  content: textResult.or(imageResult).or(audioResult).array(),
  "isError?": "boolean",
});

type ResultSchema = typeof resultSchema.infer;

/**
 * The ToolRegistry class represents a set of tools that can be used by
 * the server. It is a map of request schemas to request handlers
 * that provides a list of available tools and a method to handle requests.
 */
export class ToolRegistryClass<
  TSchema extends Type<{
    name: string;
    // `object` (not `Record<string, unknown>`) so that tools declaring
    // `arguments: {}` — i.e. no-arg tools — still type-check. See the
    // normalizeInputSchema helper below for why the empty-object form
    // is preferred over the open-record form.
    arguments?: object;
  }>,
  THandler extends (
    request: TSchema["infer"],
    context: HandlerContext,
  ) => Promise<Result>,
> extends Map<TSchema, THandler> {
  private enabled = new Set<TSchema>();

  /**
   * Memoized `list()` result. ArkType `toJsonSchema()` + the
   * normalization walk are pure functions of the enabled set, which
   * only changes via `enable()`/`disable()` — recomputing them on
   * every `tools/list` request (one per client session in stateless
   * transport) is wasted work.
   */
  private listCache: {
    tools: {
      name: string;
      description: string | undefined;
      inputSchema: Record<string, unknown>;
      annotations?: ToolAnnotations;
    }[];
  } | null = null;

  /** MCP tool annotations, keyed by public tool name (set via setAnnotations). */
  private annotationsByName = new Map<string, ToolAnnotations>();

  /** Public tool name → schema, built at register() time for O(1) lookups. */
  private byName = new Map<string, TSchema>();

  /**
   * Single extraction point for the public tool name. Every tool
   * schema declares `name` as a string literal, so its JSON Schema
   * node carries `const`; the runtime guard catches a schema that
   * doesn't.
   */
  private toolNameOf = (schema: TSchema): string => {
    const node = schema.get("name").toJsonSchema() as { const?: unknown };
    const name = node.const;
    if (typeof name !== "string") {
      throw new Error("tool schema has no string-literal name");
    }
    return name;
  };

  /**
   * Attach MCP tool annotations (readOnlyHint, destructiveHint, ...)
   * by public tool name. Lookup happens lazily in list(), so the order
   * relative to register() does not matter; entries for names that
   * never register are simply unused. Invalidates the memoized list().
   */
  setAnnotations = (byName: Record<string, ToolAnnotations>) => {
    for (const [name, annotations] of Object.entries(byName)) {
      this.annotationsByName.set(name, annotations);
    }
    this.listCache = null;
    return this;
  };

  register<
    Schema extends TSchema,
    Handler extends (
      request: Schema["infer"],
      context: HandlerContext,
    ) => ResultSchema | Promise<ResultSchema>,
  >(schema: Schema, handler: Handler) {
    const name = this.toolNameOf(schema as unknown as TSchema);
    if (this.byName.has(name)) {
      throw new Error(`Tool already registered: ${name}`);
    }
    this.byName.set(name, schema as unknown as TSchema);
    this.enable(schema);
    return super.set(
      schema as unknown as TSchema,
      handler as unknown as THandler,
    );
  }

  enable = <Schema extends TSchema>(schema: Schema) => {
    this.enabled.add(schema);
    this.listCache = null;
    return this;
  };

  disable = <Schema extends TSchema>(schema: Schema) => {
    this.enabled.delete(schema);
    this.listCache = null;
    return this;
  };

  /**
   * Disable a tool by its public name (the string used in MCP
   * `tools/list` / `tools/call`). Returns `true` if a matching tool
   * was found and disabled, `false` otherwise.
   *
   * Useful for applying user-controlled disable lists (e.g. from an
   * env var) after all features have registered their tools.
   */
  enableByName = (name: string): boolean => {
    const schema = this.byName.get(name);
    if (!schema) return false;
    this.enable(schema);
    return true;
  };

  disableByName = (name: string): boolean => {
    const schema = this.byName.get(name);
    if (!schema) return false;
    this.disable(schema);
    return true;
  };

  list = () => {
    this.listCache ??= {
      tools: Array.from(this.enabled.values()).map((schema) => {
        const name = this.toolNameOf(schema);
        const annotations = this.annotationsByName.get(name);
        return {
          name,
          description: schema.description,
          inputSchema: normalizeInputSchema(
            schema.get("arguments").toJsonSchema(),
          ),
          ...(annotations ? { annotations } : {}),
        };
      }),
    };
    return this.listCache;
  };

  listAll = (): { name: string; description: string; enabled: boolean }[] =>
    Array.from(this.keys()).map((schema) => ({
      name: this.toolNameOf(schema),
      description: schema.description ?? "",
      enabled: this.enabled.has(schema),
    }));

  /**
   * MCP SDK sends boolean values as "true" or "false". This method coerces the boolean
   * values in the request parameters to the expected type.
   *
   * @param schema Arktype schema
   * @param params MCP request parameters
   * @returns MCP request parameters with corrected boolean values
   */
  private coerceBooleanParams = <Schema extends TSchema>(
    schema: Schema,
    params: Schema["infer"],
  ): Schema["infer"] => {
    // `arguments` is typed as `object` at the registry level (so that
    // no-arg tools can declare `arguments: {}`), but inside this method
    // we need index access, so we treat it as an open dictionary.
    const args = params.arguments as Record<string, unknown> | undefined;
    const argsSchema = schema.get("arguments").exclude("undefined");
    if (!args || !argsSchema) return params;

    const fixed: Record<string, unknown> = { ...args };
    for (const [key, value] of Object.entries(args)) {
      // ArkType's typed .get() no longer accepts arbitrary string keys
      // now that the registry constraint is `object` instead of
      // `Record<string, unknown>`. Cast the schema to a loose getter for
      // this lookup — the runtime behavior is identical.
      const valueSchema = (
        argsSchema as unknown as {
          get: (k: string) => {
            exclude: (s: string) => { expression: string };
          };
        }
      )
        .get(key)
        .exclude("undefined");
      if (
        valueSchema.expression === "boolean" &&
        typeof value === "string" &&
        ["true", "false"].includes(value)
      ) {
        fixed[key] = value === "true";
      }
    }

    return { ...params, arguments: fixed };
  };

  dispatch = async <Schema extends TSchema>(
    params: Schema["infer"],
    context: HandlerContext,
  ) => {
    try {
      // O(1) name lookup. A disabled tool must behave as if it did not
      // exist — otherwise `list()` and `dispatch()` would disagree and
      // clients could invoke tools the user explicitly turned off.
      const schema = this.byName.get(params.name);
      const handler = schema ? this.get(schema) : undefined;
      if (schema && handler && this.enabled.has(schema)) {
        const validParams = schema.assert(
          this.coerceBooleanParams(schema, params),
        );
        // return await to handle runtime errors here
        return await handler(validParams, context);
      }
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Unknown tool: ${params.name}`,
      );
    } catch (error) {
      // Surface tool failures via the MCP `isError: true` envelope
      // instead of throwing the McpError up to the transport layer.
      //
      // Why: the transport's outer serializer (and at least one client
      // shim, e.g. mcp-remote when bridging stdio↔HTTP) prepends its
      // own `MCP error -<code>:` prefix to the message of any thrown
      // McpError, producing the cosmetic `MCP error -32603: MCP error
      // -32603: <text>` double-prefix folotp observed during the
      // 0.4.0-beta.2 retest on issue #74. Returning the result as
      // `isError: true` keeps the path that does NOT add a prefix —
      // the message reaches the client clean. The `executeTemplate.ts`
      // local fix in PR #69 was the same shape; this lifts the pattern
      // up so it applies uniformly to every tool that throws.
      //
      // Logging stays on `logger.error` because we still want
      // diagnostic context (stack, error, tool name) for the operator
      // even when the client-facing surface is the cleaner envelope.
      const formattedError = formatMcpError(error);
      // Log the tool name only, never params.arguments — those carry
      // user data (note content, paths, queries) onto the on-disk log.
      logger.error(`Error handling ${params.name}`, {
        ...formattedError,
        message: formattedError.message,
        stack: formattedError.stack,
        error,
        tool: params.name,
      });
      return {
        content: [{ type: "text" as const, text: formattedError.message }],
        isError: true,
      };
    }
  };
}

export type ToolRegistry = ToolRegistryClass<
  Type<{
    name: string;
    // `object` (not `Record<string, unknown>`) so that tools declaring
    // `arguments: {}` — i.e. no-arg tools — still type-check. See the
    // normalizeInputSchema helper below for why the empty-object form
    // is preferred over the open-record form.
    arguments?: object;
  }>,
  (
    request: {
      name: string;
      // `object` (not `Record<string, unknown>`) so that tools declaring
      // `arguments: {}` — i.e. no-arg tools — still type-check. See the
      // normalizeInputSchema helper below for why the empty-object form
      // is preferred over the open-record form.
      arguments?: object;
    },
    context: HandlerContext,
  ) => Promise<Result>
>;
