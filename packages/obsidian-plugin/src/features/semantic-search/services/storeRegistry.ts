import { logger } from "$/shared/logger";
import {
  createEmbeddingStore,
  type EmbeddingStore,
  type VaultAdapter,
} from "./store";

export interface EmbeddingStoreRegistry {
  storeFor(providerKey: string, vectorDim: number): EmbeddingStore;
  markReady(providerKey: string): void;
  isReady(providerKey: string): boolean;
  close(providerKey: string): Promise<void>;
  closeAll(): Promise<void>;
}

class EmbeddingStoreRegistryImpl implements EmbeddingStoreRegistry {
  private stores = new Map<string, EmbeddingStore>();
  private ready = new Set<string>();

  constructor(
    private adapter: VaultAdapter,
    private baseDir: string,
  ) {}

  storeFor(providerKey: string, vectorDim: number): EmbeddingStore {
    const existing = this.stores.get(providerKey);
    if (existing) return existing;
    const store = createEmbeddingStore({
      adapter: this.adapter,
      binPath: `${this.baseDir}/${providerKey}/embeddings.bin`,
      indexPath: `${this.baseDir}/${providerKey}/embeddings.index.json`,
      vectorDim,
    });
    this.stores.set(providerKey, store);
    return store;
  }

  markReady(providerKey: string): void {
    this.ready.add(providerKey);
  }

  isReady(providerKey: string): boolean {
    return this.ready.has(providerKey);
  }

  async close(providerKey: string): Promise<void> {
    const store = this.stores.get(providerKey);
    if (!store) return;
    await store.close();
    this.stores.delete(providerKey);
    this.ready.delete(providerKey);
  }

  async closeAll(): Promise<void> {
    const keys = Array.from(this.stores.keys());
    await Promise.all(keys.map((k) => this.close(k)));
  }
}

export function createEmbeddingStoreRegistry(
  adapter: VaultAdapter,
  baseDir: string,
): EmbeddingStoreRegistry {
  return new EmbeddingStoreRegistryImpl(adapter, baseDir);
}

/**
 * One-time migration: moves the v1 flat store pair
 * (`${pluginDir}/embeddings.bin` + `embeddings.index.json`) to the
 * per-providerKey directory (`embeddings/native-minilm-l6-v2/`).
 * Idempotent: no-op when the flat bin is absent.
 * Failures are logged and swallowed — the re-index banner handles
 * the case where the store is absent at the new path.
 */
export async function migrateV1FlatStore(
  adapter: VaultAdapter,
  pluginDir: string,
): Promise<void> {
  const srcBin = `${pluginDir}/embeddings.bin`;
  try {
    if (!(await adapter.exists(srcBin))) return;

    const srcIndex = `${pluginDir}/embeddings.index.json`;
    const dstDir = `${pluginDir}/embeddings/native-minilm-l6-v2`;

    const sentinelPath = `${dstDir}/.migrating`;

    // Sentinel-before-mutation, source-removal-after-commit (same
    // atomicity pattern as store.ts flush). Sources are only removed
    // once the sentinel is cleared, so a leftover sentinel means an
    // interrupted copy with sources still intact — safe to redo the
    // copy (idempotent overwrite) instead of abandoning the store to
    // a silent full re-index.
    const binData = await adapter.readBinary(srcBin);
    await adapter.mkdir(dstDir);
    await adapter.write(sentinelPath, "");
    await adapter.writeBinary(`${dstDir}/embeddings.bin`, binData);

    const hasIndex = await adapter.exists(srcIndex);
    if (hasIndex) {
      const indexData = await adapter.read(srcIndex);
      await adapter.write(`${dstDir}/embeddings.index.json`, indexData);
    }

    // Commit point: destination is complete.
    await adapter.remove(sentinelPath);

    // A crash between here and the last remove re-runs the migration on
    // next startup (srcBin still present), which overwrites the
    // destination with identical data.
    await adapter.remove(srcBin);
    if (hasIndex) await adapter.remove(srcIndex);
    logger.info(
      "semantic-search: v1 flat store migrated to per-provider directory",
      { pluginDir },
    );
  } catch (error) {
    logger.warn("v1 flat store migration failed; store will be re-indexed", {
      pluginDir,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
