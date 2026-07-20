import { describe, expect, test, beforeEach } from "bun:test";
import {
  base64ToBuf,
  createVaultBinaryFileHandler,
  createVaultBinaryFileSchema,
} from "./createVaultBinaryFile";
import {
  getMockFolders,
  mockApp,
  resetMockVault,
  setMockFile,
  setMockFolder,
} from "$/test-setup";

beforeEach(() => resetMockVault());

function b64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

describe("create_vault_binary_file tool", () => {
  test("schema declares the tool name", () => {
    expect(createVaultBinaryFileSchema.get("name")?.toString()).toContain(
      "create_vault_binary_file",
    );
  });

  test("base64ToBuf round-trips through btoa/atob-style encoding", () => {
    const original = "hello binary world";
    const buf = base64ToBuf(b64(original));
    const decoded = new TextDecoder().decode(buf);
    expect(decoded).toBe(original);
  });

  test("creates new binary file at root path", async () => {
    const app = mockApp();
    const result = await createVaultBinaryFileHandler({
      arguments: { path: "sketch.png", content: b64("fake-png-bytes") },
      app,
    });
    expect(result.isError).toBeUndefined();
    const file = app.vault.getAbstractFileByPath("sketch.png");
    expect(file).not.toBeNull();
    const bytes = await app.vault.readBinary(file as never);
    expect(new TextDecoder().decode(bytes)).toBe("fake-png-bytes");
  });

  test("auto-creates missing parent directories", async () => {
    const app = mockApp();
    const result = await createVaultBinaryFileHandler({
      arguments: {
        path: "Images/Journal/sketch.png",
        content: b64("bytes"),
      },
      app,
    });
    expect(result.isError).toBeUndefined();
    expect(getMockFolders()).toEqual(["Images", "Images/Journal"]);
    const file = app.vault.getAbstractFileByPath("Images/Journal/sketch.png");
    expect(file).not.toBeNull();
  });

  test("overwrites existing file when target exists", async () => {
    setMockFile("sketch.png", "OLD");
    const app = mockApp();
    const result = await createVaultBinaryFileHandler({
      arguments: { path: "sketch.png", content: b64("NEW") },
      app,
    });
    expect(result.isError).toBeUndefined();
    const file = app.vault.getAbstractFileByPath("sketch.png");
    const bytes = await app.vault.readBinary(file as never);
    expect(new TextDecoder().decode(bytes)).toBe("NEW");
  });

  test("returns isError (does not throw) when path is a folder", async () => {
    setMockFolder("Images");
    const app = mockApp();
    const result = await createVaultBinaryFileHandler({
      arguments: { path: "Images", content: b64("x") },
      app,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/folder, not a file/i);
  });

  test("returns isError (does not throw) on invalid base64", async () => {
    const app = mockApp();
    const result = await createVaultBinaryFileHandler({
      arguments: { path: "bad.png", content: "not-valid-base64!!!" },
      app,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not valid base64/i);
  });
});
