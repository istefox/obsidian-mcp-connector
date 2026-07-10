/**
 * Repeatable micro-benchmarks for the hot paths identified by the
 * 2026-07 performance audit. Pure Bun script — no Obsidian runtime, no
 * model downloads; every dependency is either a pure function or fed by
 * an in-memory mock.
 *
 * Usage (from the repo root):
 *   NODE_ENV=production bun packages/obsidian-plugin/scripts/bench.ts
 *
 * NODE_ENV=production keeps `$/shared/logger` on `console` instead of
 * the file-writing dev logger.
 *
 * Benchmarks:
 *   1. recordCall            — per-tool-call settings write (adaptive-tool-loading)
 *   2. rewriteBacklinker     — rename_heading backlink rewrite on a long doc
 *   3. store flush           — full bin+index serialize of a 20k-chunk store
 *   4. searchAndReplace scan — dry-run over a mock vault with 1ms read latency
 *
 * Each benchmark prints `name ... median ms (n runs)` plus benchmark-
 * specific counters. Run before and after an optimization and compare.
 */

import { ToolLoadingManager } from "$/features/adaptive-tool-loading";
import { rewriteBacklinker } from "$/features/mcp-tools/services/headingRename";
import { searchAndReplaceHandler } from "$/features/mcp-tools/tools/searchAndReplace";
import {
  createEmbeddingStore,
  type EmbeddingRecord,
  type VaultAdapter,
} from "$/features/semantic-search/services/store";
import type { PluginDataLike } from "$/shared/types";
import type { App, TFile } from "obsidian";

const now = (): number => performance.now();

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function report(name: string, samples: number[], extra = ""): void {
  const med = median(samples).toFixed(2);
  const min = Math.min(...samples).toFixed(2);
  console.log(
    `${name.padEnd(28)} median ${med} ms  (min ${min}, n=${samples.length})${extra ? "  " + extra : ""}`,
  );
}

// ── 1. recordCall ───────────────────────────────────────────────────────────

/** Realistic ~30KB data.json: settings + permission entries + filler. */
function makeSettingsFixture(): Record<string, unknown> {
  return {
    version: "0.22.0",
    bearerToken: "t".repeat(64),
    commandPermissions: {
      enabled: true,
      allowlist: Array.from({ length: 120 }, (_, i) => `workspace:cmd-${i}`),
      auditLog: Array.from({ length: 200 }, (_, i) => ({
        commandId: `editor:command-${i}`,
        outcome: i % 3 === 0 ? "deny" : "allow",
        timestamp: 1750000000000 + i * 60_000,
      })),
    },
    semanticSearch: {
      provider: "native",
      folders: { include: [], exclude: ["Templates/", "Archive/"] },
    },
    toolLoading: { profile: "all", counters: {}, promoted: [] },
  };
}

async function benchRecordCall(): Promise<void> {
  const CALLS = 500;
  let saves = 0;
  let loads = 0;
  let data = makeSettingsFixture() as unknown;
  const plugin: PluginDataLike = {
    loadData: async () => {
      loads += 1;
      // JSON round-trip approximates Obsidian's disk read + parse.
      return JSON.parse(JSON.stringify(data));
    },
    saveData: async (d: unknown) => {
      saves += 1;
      data = JSON.parse(JSON.stringify(d));
    },
  };
  const manager = new ToolLoadingManager();

  const samples: number[] = [];
  for (let run = 0; run < 5; run++) {
    const t0 = now();
    for (let i = 0; i < CALLS; i++) {
      await manager.recordCall(`tool_${i % 30}`, plugin);
    }
    await manager.flushPendingCalls?.(plugin);
    samples.push(now() - t0);
  }
  report(
    `recordCall x${CALLS}`,
    samples,
    `loads=${loads} saves=${saves} (5 runs)`,
  );
}

// ── 2. rewriteBacklinker ────────────────────────────────────────────────────

function makeLongDoc(lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    if (i % 97 === 0) out.push("```js");
    else if (i % 97 === 20) out.push("```");
    else if (i % 13 === 0)
      out.push(`See [[Source Note#Old Heading]] and [[Other#Else]] here.`);
    else if (i % 29 === 0)
      out.push(`A [markdown link](Source%20Note.md#Old%20Heading) too.`);
    else out.push(`Line ${i}: lorem ipsum dolor sit amet, consectetur.`);
  }
  return out.join("\n");
}

function benchRewriteBacklinker(): void {
  const doc = makeLongDoc(5000);
  const resolve = (linkpath: string): string | null =>
    linkpath.toLowerCase().startsWith("source note") ? "Source Note.md" : null;

  const samples: number[] = [];
  let rewrites = 0;
  for (let run = 0; run < 7; run++) {
    const t0 = now();
    const { rewriteCount } = rewriteBacklinker(
      doc,
      "Old Heading",
      "New Heading",
      "Source Note.md",
      "Backlinker.md",
      resolve,
    );
    samples.push(now() - t0);
    rewrites = rewriteCount;
  }
  report("rewriteBacklinker 5k lines", samples, `rewrites=${rewrites}`);
}

// ── 3. store flush ──────────────────────────────────────────────────────────

function makeMemAdapter(): VaultAdapter & { bytesWritten: () => number } {
  const files = new Map<string, string>();
  const bins = new Map<string, ArrayBuffer>();
  let bytes = 0;
  return {
    exists: async (p) => files.has(p) || bins.has(p),
    read: async (p) => files.get(p) ?? "",
    write: async (p, d) => {
      bytes += d.length;
      files.set(p, d);
    },
    readBinary: async (p) => bins.get(p) ?? new ArrayBuffer(0),
    writeBinary: async (p, d) => {
      bytes += d.byteLength;
      bins.set(p, d);
    },
    remove: async (p) => {
      files.delete(p);
      bins.delete(p);
    },
    mkdir: async () => {},
    bytesWritten: () => bytes,
  };
}

async function benchStoreFlush(): Promise<void> {
  const DIM = 384;
  const RECORDS = 20_000;
  const adapter = makeMemAdapter();
  const store = createEmbeddingStore({
    adapter,
    binPath: "/bench/embeddings.bin",
    indexPath: "/bench/embeddings.index.json",
    vectorDim: DIM,
  });
  await store.init();

  const records: EmbeddingRecord[] = Array.from(
    { length: RECORDS },
    (_, i) => ({
      // Store keys records by chunkId globally; the indexer composes
      // `${path}#${ordinal}` — mirror that shape.
      chunkId: `notes/file-${Math.floor(i / 40)}.md#${i % 40}`,
      filePath: `notes/file-${Math.floor(i / 40)}.md`,
      offset: (i % 40) * 500,
      heading: i % 3 === 0 ? null : `Heading ${i % 40}`,
      contentHash: (i * 2654435761).toString(16).padStart(16, "0"),
      vector: new Float32Array(DIM).fill(i / RECORDS),
    }),
  );
  await store.upsert(records);
  await store.flush();

  // Steady-state cost: touch ONE file, flush again — today this rewrites
  // the whole store.
  const samples: number[] = [];
  for (let run = 0; run < 5; run++) {
    await store.upsert(records.slice(0, 40)); // one file's records
    const t0 = now();
    await store.flush();
    samples.push(now() - t0);
  }
  const mb = (adapter.bytesWritten() / 1024 / 1024).toFixed(1);
  report(`store flush 20k x ${DIM}`, samples, `totalWritten=${mb}MB`);
}

// ── 4. searchAndReplace scan ────────────────────────────────────────────────

async function benchSearchAndReplace(): Promise<void> {
  const FILES = 800;
  const contents = new Map<string, string>();
  const tfiles = Array.from({ length: FILES }, (_, i) => {
    const path = `notes/note-${i}.md`;
    contents.set(
      path,
      `# Note ${i}\n\nSome text with target-${i % 50} inside.\n${"filler line\n".repeat(30)}`,
    );
    return { path } as TFile;
  });
  const app = {
    vault: {
      getMarkdownFiles: () => tfiles,
      read: async (f: TFile) => {
        // Simulated per-file I/O latency (SSD read + IPC).
        await new Promise((r) => setTimeout(r, 1));
        return contents.get(f.path) ?? "";
      },
      modify: async () => {},
    },
  } as unknown as App;

  const samples: number[] = [];
  for (let run = 0; run < 3; run++) {
    const t0 = now();
    await searchAndReplaceHandler({
      arguments: { pattern: "target-1\\b", replacement: "replaced" },
      app,
    });
    samples.push(now() - t0);
  }
  report(`searchAndReplace ${FILES} files`, samples);
}

// ── main ────────────────────────────────────────────────────────────────────

console.log(`bench.ts — ${new Date().toISOString()} bun ${Bun.version}`);
await benchRecordCall();
benchRewriteBacklinker();
await benchStoreFlush();
await benchSearchAndReplace();
