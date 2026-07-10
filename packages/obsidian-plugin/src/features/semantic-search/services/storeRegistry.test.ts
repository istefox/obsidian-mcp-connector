import { describe, expect, test, beforeEach } from "bun:test";
import {
  createEmbeddingStoreRegistry,
  migrateV1FlatStore,
} from "./storeRegistry";
import type { VaultAdapter } from "./store";

function makeMemAdapter(): {
  adapter: VaultAdapter;
  files: Map<string, string>;
  bins: Map<string, ArrayBuffer>;
} {
  const files = new Map<string, string>();
  const bins = new Map<string, ArrayBuffer>();
  const adapter: VaultAdapter = {
    async exists(path) {
      return files.has(path) || bins.has(path);
    },
    async read(path) {
      const v = files.get(path);
      if (v === undefined) throw new Error(`ENOENT ${path}`);
      return v;
    },
    async write(path, data) {
      files.set(path, data);
    },
    async readBinary(path) {
      const v = bins.get(path);
      if (v === undefined) throw new Error(`ENOENT ${path}`);
      return v.slice(0);
    },
    async writeBinary(path, data) {
      bins.set(path, data.slice(0));
    },
    async remove(path) {
      files.delete(path);
      bins.delete(path);
    },
    async mkdir() {},
  };
  return { adapter, files, bins };
}

describe("EmbeddingStoreRegistry", () => {
  let mem: ReturnType<typeof makeMemAdapter>;

  beforeEach(() => {
    mem = makeMemAdapter();
  });

  test("storeFor returns the same instance for the same providerKey", () => {
    const registry = createEmbeddingStoreRegistry(
      mem.adapter,
      "/plugin/embeddings",
    );
    const a = registry.storeFor("native-minilm-l6-v2", 384);
    const b = registry.storeFor("native-minilm-l6-v2", 384);
    expect(a).toBe(b);
  });

  test("storeFor returns different instances for different providerKeys", () => {
    const registry = createEmbeddingStoreRegistry(
      mem.adapter,
      "/plugin/embeddings",
    );
    const a = registry.storeFor("native-minilm-l6-v2", 384);
    const b = registry.storeFor("embedding-gemma-300m", 768);
    expect(a).not.toBe(b);
  });

  test("markReady + isReady round-trip", () => {
    const registry = createEmbeddingStoreRegistry(
      mem.adapter,
      "/plugin/embeddings",
    );
    expect(registry.isReady("native-minilm-l6-v2")).toBe(false);
    registry.markReady("native-minilm-l6-v2");
    expect(registry.isReady("native-minilm-l6-v2")).toBe(true);
  });

  test("close removes store and ready flag", async () => {
    const registry = createEmbeddingStoreRegistry(
      mem.adapter,
      "/plugin/embeddings",
    );
    const s1 = registry.storeFor("native-minilm-l6-v2", 384);
    registry.markReady("native-minilm-l6-v2");
    await registry.close("native-minilm-l6-v2");
    expect(registry.isReady("native-minilm-l6-v2")).toBe(false);
    // After close, storeFor creates a fresh instance.
    const s2 = registry.storeFor("native-minilm-l6-v2", 384);
    expect(s2).not.toBe(s1);
  });

  test("closeAll closes every known store", async () => {
    const registry = createEmbeddingStoreRegistry(
      mem.adapter,
      "/plugin/embeddings",
    );
    registry.storeFor("native-minilm-l6-v2", 384);
    registry.storeFor("embedding-gemma-300m", 768);
    registry.markReady("native-minilm-l6-v2");
    registry.markReady("embedding-gemma-300m");
    await registry.closeAll();
    expect(registry.isReady("native-minilm-l6-v2")).toBe(false);
    expect(registry.isReady("embedding-gemma-300m")).toBe(false);
  });
});

describe("migrateV1FlatStore", () => {
  let mem: ReturnType<typeof makeMemAdapter>;

  beforeEach(() => {
    mem = makeMemAdapter();
  });

  test("no-op when flat bin is absent", async () => {
    await migrateV1FlatStore(mem.adapter, "/plugin");
    expect(mem.bins.size).toBe(0);
    expect(mem.files.size).toBe(0);
  });

  test("moves bin and index to per-providerKey path", async () => {
    const binData = new Float32Array([1, 2, 3, 4]).buffer;
    const indexData = JSON.stringify({ version: 1, records: [] });
    await mem.adapter.writeBinary("/plugin/embeddings.bin", binData);
    await mem.adapter.write("/plugin/embeddings.index.json", indexData);

    await migrateV1FlatStore(mem.adapter, "/plugin");

    expect(await mem.adapter.exists("/plugin/embeddings.bin")).toBe(false);
    expect(await mem.adapter.exists("/plugin/embeddings.index.json")).toBe(
      false,
    );
    expect(
      await mem.adapter.exists(
        "/plugin/embeddings/native-minilm-l6-v2/embeddings.bin",
      ),
    ).toBe(true);
    expect(
      await mem.adapter.exists(
        "/plugin/embeddings/native-minilm-l6-v2/embeddings.index.json",
      ),
    ).toBe(true);
  });

  test("idempotent: second call is a no-op", async () => {
    const binData = new Float32Array([1]).buffer;
    await mem.adapter.writeBinary("/plugin/embeddings.bin", binData);

    await migrateV1FlatStore(mem.adapter, "/plugin");
    // Flat bin is gone after first migration.
    expect(await mem.adapter.exists("/plugin/embeddings.bin")).toBe(false);

    // Second call: no-op, no error.
    await expect(
      migrateV1FlatStore(mem.adapter, "/plugin"),
    ).resolves.toBeUndefined();
  });

  test("interrupted migration (leftover sentinel) retries and completes", async () => {
    const binData = new Float32Array([1, 2]).buffer;
    const indexData = JSON.stringify({ version: 1, records: [] });
    await mem.adapter.writeBinary("/plugin/embeddings.bin", binData);
    await mem.adapter.write("/plugin/embeddings.index.json", indexData);
    // Simulate a crash mid-copy: sentinel written, destination partial,
    // sources still intact (sources are only removed after commit).
    await mem.adapter.mkdir("/plugin/embeddings/native-minilm-l6-v2");
    await mem.adapter.write(
      "/plugin/embeddings/native-minilm-l6-v2/.migrating",
      "",
    );

    await migrateV1FlatStore(mem.adapter, "/plugin");

    // The retry must complete the move, not abandon the store.
    expect(await mem.adapter.exists("/plugin/embeddings.bin")).toBe(false);
    expect(
      await mem.adapter.exists(
        "/plugin/embeddings/native-minilm-l6-v2/embeddings.bin",
      ),
    ).toBe(true);
    expect(
      await mem.adapter.exists(
        "/plugin/embeddings/native-minilm-l6-v2/embeddings.index.json",
      ),
    ).toBe(true);
    expect(
      await mem.adapter.exists(
        "/plugin/embeddings/native-minilm-l6-v2/.migrating",
      ),
    ).toBe(false);
  });

  test("gracefully handles missing index file (bin-only state)", async () => {
    const binData = new Float32Array([1]).buffer;
    await mem.adapter.writeBinary("/plugin/embeddings.bin", binData);
    // No index.json present.

    await migrateV1FlatStore(mem.adapter, "/plugin");

    expect(await mem.adapter.exists("/plugin/embeddings.bin")).toBe(false);
    expect(
      await mem.adapter.exists(
        "/plugin/embeddings/native-minilm-l6-v2/embeddings.bin",
      ),
    ).toBe(true);
  });
});
