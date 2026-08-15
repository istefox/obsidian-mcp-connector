import { describe, expect, test } from "bun:test";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { ResourceRegistryClass } from "./resourceRegistry";

describe("ResourceRegistryClass", () => {
  test("list() returns an empty resource array before setLister is called", async () => {
    const registry = new ResourceRegistryClass();
    const result = await registry.list();
    expect(result).toEqual({ resources: [] });
  });

  test("list() returns entries from the registered lister", async () => {
    const registry = new ResourceRegistryClass();
    const entries = [
      { uri: "test://widget", name: "Widget", mimeType: "text/plain" },
    ];
    registry.setLister(async () => entries);
    const result = await registry.list();
    expect(result).toEqual({ resources: entries });
  });

  test("read() throws ProtocolError(InvalidParams) naming the URI when no reader is registered", async () => {
    const registry = new ResourceRegistryClass();
    await expect(registry.read({ uri: "test://widget" })).rejects.toMatchObject(
      { code: ProtocolErrorCode.InvalidParams },
    );
    await expect(registry.read({ uri: "test://widget" })).rejects.toThrow(
      /test:\/\/widget/,
    );
    await expect(
      registry.read({ uri: "test://widget" }),
    ).rejects.toBeInstanceOf(ProtocolError);
  });

  test("setReader()/read() round-trip for a declared URI", async () => {
    const registry = new ResourceRegistryClass();
    registry.setReader(async (uri) => ({
      contents: [{ uri, mimeType: "text/plain", text: "hello" }],
    }));
    const result = await registry.read({ uri: "test://widget" });
    expect(result).toEqual({
      contents: [
        { uri: "test://widget", mimeType: "text/plain", text: "hello" },
      ],
    });
  });
});
