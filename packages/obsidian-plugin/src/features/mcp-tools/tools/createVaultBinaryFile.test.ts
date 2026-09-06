import { describe, expect, test, beforeEach } from "bun:test";
import {
  base64ToBuf,
  createVaultBinaryFileHandler,
  createVaultBinaryFileSchema,
} from "./createVaultBinaryFile";
import {
  getMockFolders,
  mockApp,
  mockPlugin,
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

// R-08 / ADR-0023: the tool's advertised JSON-schema `pattern` constraint
// for `content` is simplified for token cost, but validation is LAYERED —
// this must not weaken the runtime check. Two independent layers exist:
//   1. The ArkType schema itself (`string.base64` or whatever replaces it),
//      enforced by `schema.assert()` at the ToolRegistry.dispatch() gate
//      BEFORE the handler ever runs.
//   2. The handler's own atob() decode try/catch (createVaultBinaryFile.ts
//      base64ToBuf, exercised by "returns isError ... on invalid base64"
//      above).
// This describe block locks in layer 1 directly against the exported
// schema, independent of the registry, so a simplified pattern that
// silently drops the ArkType-level check cannot pass while layer 2 alone
// keeps the handler-level test above green.
describe("create_vault_binary_file — schema-level base64 validation is not weakened (R-08)", () => {
  test("schema.assert rejects non-base64 content before the handler ever runs", () => {
    expect(() =>
      createVaultBinaryFileSchema.assert({
        name: "create_vault_binary_file",
        arguments: { path: "bad.png", content: "not-valid-base64!!!" },
      }),
    ).toThrow();
  });

  test("schema.assert rejects content with characters outside the base64 alphabet", () => {
    // Underscore and '@' are outside even a loosened base64 charset; this
    // must fail regardless of how the pattern is simplified.
    expect(() =>
      createVaultBinaryFileSchema.assert({
        name: "create_vault_binary_file",
        arguments: { path: "bad.png", content: "abc_def@ghi" },
      }),
    ).toThrow();
  });

  test("schema.assert accepts genuinely valid base64 content unchanged", () => {
    const validB64 = b64("fake-png-bytes");
    expect(() =>
      createVaultBinaryFileSchema.assert({
        name: "create_vault_binary_file",
        arguments: { path: "ok.png", content: validB64 },
      }),
    ).not.toThrow();
  });
});

describe("create_vault_binary_file — overwrite write precondition (ADR-0022)", () => {
  const FILE = "Images/precond.png";

  async function readBackBytes(
    app: ReturnType<typeof mockApp>,
  ): Promise<string> {
    const file = app.vault.getAbstractFileByPath(FILE);
    const bytes = await app.vault.readBinary(file as never);
    return new TextDecoder().decode(bytes);
  }

  function expectStalePrecondition(
    result: {
      content: Array<{ type: "text"; text: string }>;
      isError?: boolean;
    },
    path: string = FILE,
  ): void {
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text) as {
      error: string;
      errorCode: string;
      path: string;
    };
    expect(parsed.errorCode).toBe("stale_precondition");
    expect(parsed.path).toBe(path);
  }

  test("path does not exist, overwrite absent: creates regardless of the toggle", async () => {
    const app = mockApp();
    const result = await createVaultBinaryFileHandler({
      arguments: { path: FILE, content: b64("bytes") },
      app,
    });
    expect(result.isError).toBeUndefined();
    expect(await readBackBytes(app)).toBe("bytes");
  });

  test("path exists, overwrite absent, toggle off: overwrites (unchanged)", async () => {
    setMockFile(FILE, "OLD");
    const app = mockApp();
    const result = await createVaultBinaryFileHandler({
      arguments: { path: FILE, content: b64("NEW") },
      app,
    });
    expect(result.isError).toBeUndefined();
    expect(await readBackBytes(app)).toBe("NEW");
  });

  test("path exists, overwrite absent, toggle on: refused, content byte-identical after", async () => {
    setMockFile(FILE, "OLD");
    const app = mockApp();
    const plugin = mockPlugin({
      app,
      loadData: async () => ({ mcpTools: { requireWritePreconditions: true } }),
    } as never);
    const result = await createVaultBinaryFileHandler({
      arguments: { path: FILE, content: b64("NEW") },
      app,
      plugin,
    });
    expectStalePrecondition(result);
    expect(result.content[0].text).toContain("requires a write precondition");
    expect(await readBackBytes(app)).toBe("OLD");
  });

  test("path exists, overwrite: true: overwrites regardless of the toggle", async () => {
    setMockFile(FILE, "OLD");
    const app = mockApp();
    const plugin = mockPlugin({
      app,
      loadData: async () => ({ mcpTools: { requireWritePreconditions: true } }),
    } as never);
    const result = await createVaultBinaryFileHandler({
      arguments: { path: FILE, content: b64("NEW"), overwrite: true },
      app,
      plugin,
    });
    expect(result.isError).toBeUndefined();
    expect(await readBackBytes(app)).toBe("NEW");
  });

  test("path exists, overwrite: false: refused regardless of the toggle, content byte-identical after", async () => {
    setMockFile(FILE, "OLD");
    const app = mockApp();
    const result = await createVaultBinaryFileHandler({
      arguments: { path: FILE, content: b64("NEW"), overwrite: false },
      app,
    });
    expectStalePrecondition(result);
    expect(await readBackBytes(app)).toBe("OLD");
  });

  // Regression guard for the independent TOCTOU bug this ADR fixes: unlike
  // every other vault-writing tool, this handler never acquired the vault
  // write lock at all before ADR-0022. Two concurrent calls to the same NEW
  // path are serialized by withVaultWriteLock in acquisition order, so by
  // the time the second call's exists-check runs, the first call's create
  // has already landed — overwrite: false on the second then correctly
  // refuses it instead of racing past the check to a second unconditional
  // create.
  test("two concurrent writes to the same new path are serialized by the write lock", async () => {
    const app = mockApp();
    const [first, second] = await Promise.all([
      createVaultBinaryFileHandler({
        arguments: { path: "race.png", content: b64("first") },
        app,
      }),
      createVaultBinaryFileHandler({
        arguments: {
          path: "race.png",
          content: b64("second"),
          overwrite: false,
        },
        app,
      }),
    ]);
    expect(first.isError).toBeUndefined();
    expectStalePrecondition(second, "race.png");
    const file = app.vault.getAbstractFileByPath("race.png");
    const bytes = await app.vault.readBinary(file as never);
    expect(new TextDecoder().decode(bytes)).toBe("first");
  });
});
