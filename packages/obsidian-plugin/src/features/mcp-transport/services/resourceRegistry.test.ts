import { describe, expect, test } from "bun:test";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { ResourceRegistryClass } from "./resourceRegistry";

const UI_URI = "ui://mcp-connector/spike";

describe("ResourceRegistryClass", () => {
  test("list() returns empty array before setLister is called", async () => {
    const registry = new ResourceRegistryClass();
    const result = await registry.list();
    expect(result).toEqual({ resources: [] });
  });

  test("list() returns entries from registered lister", async () => {
    const registry = new ResourceRegistryClass();
    const entries = [
      {
        uri: UI_URI,
        name: "spike",
        mimeType: "text/html;profile=mcp-app",
      },
    ];
    registry.setLister(async () => entries);
    const result = await registry.list();
    expect(result).toEqual({ resources: entries });
  });

  test("read() throws ProtocolError(InvalidParams) when no reader is registered", async () => {
    const registry = new ResourceRegistryClass();
    await expect(registry.read({ uri: UI_URI })).rejects.toMatchObject({
      code: ProtocolErrorCode.InvalidParams,
    });
  });

  test("read() propagates a ProtocolError thrown by the reader", async () => {
    const registry = new ResourceRegistryClass();
    registry.setReader(async (uri) => {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Resource not found: ${uri}`,
      );
    });
    await expect(registry.read({ uri: "ui://unknown" })).rejects.toBeInstanceOf(
      ProtocolError,
    );
  });

  test("read() delegates to the reader with the requested uri", async () => {
    const registry = new ResourceRegistryClass();
    const received: string[] = [];
    registry.setReader(async (uri) => {
      received.push(uri);
      return {
        contents: [
          { uri, mimeType: "text/html;profile=mcp-app", text: "<p>ok</p>" },
        ],
      };
    });
    const result = await registry.read({ uri: UI_URI });
    expect(received).toEqual([UI_URI]);
    expect(result.contents[0]).toEqual({
      uri: UI_URI,
      mimeType: "text/html;profile=mcp-app",
      text: "<p>ok</p>",
    });
  });
});
