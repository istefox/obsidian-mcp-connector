import { describe, expect, test } from "bun:test";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { PromptRegistryClass } from "./promptRegistry";

describe("PromptRegistryClass", () => {
  test("list() returns empty array before setLister is called", async () => {
    const registry = new PromptRegistryClass();
    const result = await registry.list();
    expect(result).toEqual({ prompts: [] });
  });

  test("list() returns entries from registered lister", async () => {
    const registry = new PromptRegistryClass();
    const entries = [
      {
        name: "greet",
        description: "A greeting prompt",
        arguments: [
          {
            name: "name",
            description: "The name to greet",
            required: false as const,
          },
        ],
      },
    ];
    registry.setLister(async () => entries);
    const result = await registry.list();
    expect(result).toEqual({ prompts: entries });
  });

  test("dispatch() throws McpError(InvalidParams) when no handler is registered", async () => {
    const registry = new PromptRegistryClass();
    await expect(registry.dispatch({ name: "unknown" })).rejects.toMatchObject({
      code: ProtocolErrorCode.InvalidParams,
    });
  });

  test("dispatch() throws McpError when handler throws McpError", async () => {
    const registry = new PromptRegistryClass();
    registry.setHandler("*", async (_name, _args) => {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        "Prompt not found: unknown",
      );
    });
    await expect(registry.dispatch({ name: "unknown" })).rejects.toBeInstanceOf(
      ProtocolError,
    );
  });

  test("dispatch() delegates to wildcard handler with correct name and args", async () => {
    const registry = new PromptRegistryClass();
    const received: { name: string; args: Record<string, string> }[] = [];
    registry.setHandler("*", async (name, args) => {
      received.push({ name, args });
      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text: `Hello ${args.who ?? ""}` },
          },
        ],
      };
    });
    const result = await registry.dispatch({
      name: "greet",
      arguments: { who: "world" },
    });
    expect(received).toEqual([{ name: "greet", args: { who: "world" } }]);
    expect(result.messages[0].content.text).toBe("Hello world");
  });

  test("dispatch() passes empty object when arguments is undefined", async () => {
    const registry = new PromptRegistryClass();
    const received: Record<string, string>[] = [];
    registry.setHandler("*", async (_name, args) => {
      received.push(args);
      return {
        messages: [{ role: "user", content: { type: "text", text: "ok" } }],
      };
    });
    await registry.dispatch({ name: "no-args" });
    expect(received).toEqual([{}]);
  });
});
