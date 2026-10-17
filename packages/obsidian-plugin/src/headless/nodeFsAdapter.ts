/**
 * The embedding store's `VaultAdapter` over a plain directory outside the
 * vault, for the headless server. The store holds note paths and headings
 * in clear text, so directories are created 0700 and files 0600, and a
 * write goes to a temporary file that is renamed into place. A path that
 * would leave the directory is refused.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { VaultAdapter } from "$/features/semantic-search/services/store";

export function nodeFsAdapter(root: string): VaultAdapter {
  const base = path.resolve(root);
  const abs = (p: string): string => {
    const full = path.resolve(base, `.${path.sep}${p}`);
    if (full !== base && !full.startsWith(base + path.sep)) {
      throw new Error(`Path escapes the cache directory: ${p}`);
    }
    return full;
  };
  const writeAtomic = async (
    p: string,
    data: string | Uint8Array,
  ): Promise<void> => {
    const file = abs(p);
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(
      dir,
      `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      await fs.writeFile(tmp, data, { mode: 0o600 });
      await fs.rename(tmp, file);
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  };
  return {
    exists: async (p) =>
      fs.access(abs(p)).then(
        () => true,
        () => false,
      ),
    read: async (p) => fs.readFile(abs(p), "utf8"),
    write: async (p, data) => writeAtomic(p, data),
    readBinary: async (p) => {
      const buf = await fs.readFile(abs(p));
      return buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      ) as ArrayBuffer;
    },
    writeBinary: async (p, data) => writeAtomic(p, new Uint8Array(data)),
    remove: async (p) => fs.rm(abs(p), { force: true }),
    mkdir: async (p) => {
      await fs.mkdir(abs(p), { recursive: true, mode: 0o700 });
    },
  };
}
