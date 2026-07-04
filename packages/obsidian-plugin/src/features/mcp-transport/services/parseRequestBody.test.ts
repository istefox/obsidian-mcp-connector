import { describe, expect, test } from "bun:test";
import { bodyTargetsActivateTool } from "./parseRequestBody";

const activateCall = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "activate_tool", arguments: { name: "get_backlinks" } },
};

const otherCall = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "list_vault_files", arguments: {} },
};

describe("bodyTargetsActivateTool", () => {
  test("true for a single activate_tool call", () => {
    expect(bodyTargetsActivateTool(activateCall)).toBe(true);
  });

  test("false for a different tools/call", () => {
    expect(bodyTargetsActivateTool(otherCall)).toBe(false);
  });

  test("false for a non tools/call method", () => {
    expect(
      bodyTargetsActivateTool({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    ).toBe(false);
  });

  test("true when a batch contains an activate_tool call", () => {
    expect(bodyTargetsActivateTool([otherCall, activateCall])).toBe(true);
  });

  test("false when a batch has no activate_tool call", () => {
    expect(bodyTargetsActivateTool([otherCall, otherCall])).toBe(false);
  });

  test("false for a notification with no params", () => {
    expect(
      bodyTargetsActivateTool({ jsonrpc: "2.0", method: "tools/call" }),
    ).toBe(false);
  });

  test("false for null / non-object bodies", () => {
    expect(bodyTargetsActivateTool(null)).toBe(false);
    expect(bodyTargetsActivateTool("nope")).toBe(false);
    expect(bodyTargetsActivateTool(42)).toBe(false);
  });

  test("false for params without a name", () => {
    expect(
      bodyTargetsActivateTool({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { arguments: {} },
      }),
    ).toBe(false);
  });
});
