import { describe, expect, test } from "bun:test";
import { bodyTargetsSseNotificationTool } from "./parseRequestBody";

const activateCall = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "activate_tool", arguments: { name: "get_backlinks" } },
};

const searchVaultSmartCall = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "search_vault_smart", arguments: { query: "x" } },
};

const otherCall = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "list_vault_files", arguments: {} },
};

describe("bodyTargetsSseNotificationTool", () => {
  test("true for a single activate_tool call", () => {
    expect(bodyTargetsSseNotificationTool(activateCall)).toBe(true);
  });

  test("true for a batch activate_tools call", () => {
    expect(
      bodyTargetsSseNotificationTool({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "activate_tools", arguments: { names: ["a", "b"] } },
      }),
    ).toBe(true);
  });

  test("true for a search_vault_smart call (#344)", () => {
    expect(bodyTargetsSseNotificationTool(searchVaultSmartCall)).toBe(true);
  });

  test("false for a different tools/call", () => {
    expect(bodyTargetsSseNotificationTool(otherCall)).toBe(false);
  });

  test("false for a non tools/call method", () => {
    expect(
      bodyTargetsSseNotificationTool({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    ).toBe(false);
  });

  test("true when a batch contains an activate_tool call", () => {
    expect(bodyTargetsSseNotificationTool([otherCall, activateCall])).toBe(
      true,
    );
  });

  test("false when a batch has no SSE-notification-tool call", () => {
    expect(bodyTargetsSseNotificationTool([otherCall, otherCall])).toBe(false);
  });

  test("false for a notification with no params", () => {
    expect(
      bodyTargetsSseNotificationTool({ jsonrpc: "2.0", method: "tools/call" }),
    ).toBe(false);
  });

  test("false for null / non-object bodies", () => {
    expect(bodyTargetsSseNotificationTool(null)).toBe(false);
    expect(bodyTargetsSseNotificationTool("nope")).toBe(false);
    expect(bodyTargetsSseNotificationTool(42)).toBe(false);
  });

  test("false for params without a name", () => {
    expect(
      bodyTargetsSseNotificationTool({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { arguments: {} },
      }),
    ).toBe(false);
  });
});
