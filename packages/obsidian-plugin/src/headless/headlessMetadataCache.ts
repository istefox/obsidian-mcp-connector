/**
 * The `app.metadataCache` the headless vault exposes.
 *
 * Holds one `CachedMetadata` per markdown file plus the two link maps
 * Obsidian keeps (`resolvedLinks`, `unresolvedLinks`). Resolution depends
 * on the whole file set (creating `B.md` resolves an unchanged `A.md`
 * that links `[[B]]`), so any change to the set recomputes every file's
 * entries. A change to one file's content recomputes just that file.
 *
 * A note the parser cannot handle is logged and kept with empty metadata,
 * so one bad file never stops a scan or the server.
 */

import { createHash } from "node:crypto";
import type { CachedMetadata } from "obsidian";
import { HeadlessEvents } from "./events";
import { logger } from "$/shared/logger";
import {
  createLinkResolver,
  memoizeByFolder,
  type LinkResolver,
} from "./linkResolution";
import { parseMetadata } from "./parseMetadata";
import type { TFile } from "./obsidianShim";

/** What the cache needs from the vault: the file set and file lookup. */
export interface FileIndex {
  allPaths(): Iterable<string>;
  getFileByPath(path: string): TFile | null;
}

type LinkMap = Record<string, Record<string, number>>;

/** Seams for tests. Production uses the defaults. */
export type MetadataCacheOptions = {
  parse?: (content: string) => CachedMetadata;
  warn?: (message: string) => void;
  createResolver?: (paths: Iterable<string>) => LinkResolver;
};

function fingerprint(content: string): string {
  return createHash("sha1").update(content).digest("base64");
}

export class HeadlessMetadataCache extends HeadlessEvents {
  private readonly caches = new Map<string, CachedMetadata>();
  /** What each cache was parsed from, to tell a stale cache from a current one. */
  private readonly fingerprints = new Map<string, string>();
  private resolver: LinkResolver | null = null;
  private batchDepth = 0;
  private dirty = false;
  resolvedLinks: LinkMap = {};
  unresolvedLinks: LinkMap = {};

  private readonly parse: (content: string) => CachedMetadata;
  private readonly warn: (message: string) => void;
  private readonly createResolver: (paths: Iterable<string>) => LinkResolver;

  constructor(
    private readonly index: FileIndex,
    options: MetadataCacheOptions = {},
  ) {
    super();
    this.parse = options.parse ?? parseMetadata;
    this.warn = options.warn ?? ((message) => logger.warn(message));
    this.createResolver = options.createResolver ?? createLinkResolver;
  }

  getFileCache(file: { path: string }): CachedMetadata | null {
    return this.caches.get(file.path) ?? null;
  }

  getCache(path: string): CachedMetadata | null {
    return this.caches.get(path) ?? null;
  }

  /**
   * The cache of `file` when it was parsed from exactly `content`, else
   * null. A disk edit the watcher has not yet reconciled leaves a cache
   * whose positions no longer fit the text.
   */
  getFileCacheIfCurrent(
    file: { path: string },
    content: string,
  ): CachedMetadata | null {
    return this.fingerprints.get(file.path) === fingerprint(content)
      ? (this.caches.get(file.path) ?? null)
      : null;
  }

  /** The Files & Links "Excluded files" setting has no headless equivalent. */
  isUserIgnored(_path: string): boolean {
    return false;
  }

  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
    this.resolver ??= this.createResolver(this.index.allPaths());
    const dest = this.resolver.resolve(linkpath, sourcePath);
    return dest === null ? null : this.index.getFileByPath(dest);
  }

  /** Tag occurrence counts across the vault, inline and frontmatter, keyed `#tag`. */
  getTags(): Record<string, number> {
    const counts: Record<string, number> = {};
    const add = (raw: string) => {
      const tag = raw.startsWith("#") ? raw : `#${raw}`;
      counts[tag] = (counts[tag] ?? 0) + 1;
    };
    for (const cache of this.caches.values()) {
      for (const t of cache.tags ?? []) add(t.tag);
      const fmTags = cache.frontmatter?.tags as unknown;
      if (Array.isArray(fmTags)) {
        for (const t of fmTags) if (typeof t === "string") add(t);
      } else if (typeof fmTags === "string") {
        add(fmTags);
      }
    }
    return counts;
  }

  /**
   * Parse `content` for `file` and store it. Idempotent for unchanged
   * content. `recompute` is false for a new file, whose entries the
   * all-files pass that follows will fill in.
   */
  setContent(file: TFile, content: string, recompute = true): void {
    let cache: CachedMetadata;
    try {
      cache = this.parse(content);
    } catch (err) {
      this.warn(
        `Could not parse ${file.path}; indexed without metadata: ${err instanceof Error ? err.message : String(err)}`,
      );
      cache = {};
    }
    this.caches.set(file.path, cache);
    this.fingerprints.set(file.path, fingerprint(content));
    if (recompute && !this.dirty) this.recomputeFile(file.path);
    this.trigger("changed", file, content, cache);
  }

  removeFile(file: TFile): void {
    const previous = this.caches.get(file.path);
    this.caches.delete(file.path);
    this.fingerprints.delete(file.path);
    delete this.resolvedLinks[file.path];
    delete this.unresolvedLinks[file.path];
    this.trigger("deleted", file, previous);
  }

  /**
   * `file` moved from `oldPath` to the path it now has: its cache goes with
   * it. Call `fileSetChanged` once the whole move is applied.
   */
  moveFile(file: { path: string }, oldPath: string): void {
    const cache = this.caches.get(oldPath);
    const print = this.fingerprints.get(oldPath);
    this.caches.delete(oldPath);
    this.fingerprints.delete(oldPath);
    delete this.resolvedLinks[oldPath];
    delete this.unresolvedLinks[oldPath];
    if (cache) this.caches.set(file.path, cache);
    if (print !== undefined) this.fingerprints.set(file.path, print);
  }

  /** The file set changed: every resolution may have changed with it. */
  fileSetChanged(): void {
    this.resolver = null;
    if (this.batchDepth > 0) {
      this.dirty = true;
      return;
    }
    this.recomputeAll();
  }

  /**
   * Defer the all-files recompute to the end of `fn`, so a rescan or a
   * burst of external changes costs one pass instead of one per file.
   */
  async batch<T>(fn: () => Promise<T>): Promise<T> {
    this.batchDepth += 1;
    try {
      return await fn();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.dirty) {
        this.dirty = false;
        this.recomputeAll();
      }
    }
  }

  private recomputeAll(): void {
    this.resolver = this.createResolver(this.index.allPaths());
    // Many notes share a link and a folder; resolve each pair once per pass.
    const resolver = memoizeByFolder(this.resolver);
    this.resolvedLinks = {};
    this.unresolvedLinks = {};
    for (const path of this.caches.keys()) this.recomputeFile(path, resolver);
    this.trigger("resolved");
  }

  private recomputeFile(path: string, resolver?: LinkResolver): void {
    const cache = this.caches.get(path);
    if (!cache) return;
    this.resolver ??= this.createResolver(this.index.allPaths());
    const linkResolver = resolver ?? this.resolver;
    const resolved: Record<string, number> = {};
    const unresolved: Record<string, number> = {};
    const refs = [
      ...(cache.links ?? []),
      ...(cache.embeds ?? []),
      ...(cache.frontmatterLinks ?? []),
    ];
    for (const ref of refs) {
      const hash = ref.link.indexOf("#");
      const linkpath = hash < 0 ? ref.link : ref.link.slice(0, hash);
      // `[[#Heading]]` points at the note itself.
      const dest =
        linkpath === "" ? path : linkResolver.resolve(linkpath, path);
      if (dest === null) {
        unresolved[linkpath] = (unresolved[linkpath] ?? 0) + 1;
      } else {
        resolved[dest] = (resolved[dest] ?? 0) + 1;
      }
    }
    this.resolvedLinks[path] = resolved;
    this.unresolvedLinks[path] = unresolved;
  }
}
