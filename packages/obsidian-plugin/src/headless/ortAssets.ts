/**
 * The two ONNX runtime files the CPU embedder needs, kept in a local
 * folder. Node's `import()` accepts only `file:` and `data:` URLs, so
 * the CDN address the desktop plugin hands onnxruntime-web cannot be used
 * here: the glue script must be a real file. Both files are fetched once
 * from the same jsDelivr URL the desktop uses and checked against a
 * pinned SHA-256 before they are written, so a tampered CDN response is
 * never executed. A cached file is re-checked on use.
 *
 * Bumping onnxruntime-web means updating `ORT_VERSION` and the hashes
 * together with `ORT_WASM_PATHS` in semantic-search/services/onnxEnv.ts.
 * A test compares the pins with the installed package.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ORT_VERSION = "1.26.0";
export const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

/** File name to SHA-256 (hex). Download size: about 13 MB, almost all of it the .wasm. */
export const ORT_ASSETS: Readonly<Record<string, string>> = {
  "ort-wasm-simd-threaded.mjs":
    "2de262ca1fe2d6e0ef9236bf77632fa01de232ce7b6a33071c37637ee53f4669",
  "ort-wasm-simd-threaded.wasm":
    "040d52ce5066707a10d45cb9500c35e70a9c2fb33c4fb63428da9ae45b956b97",
};

export type OrtAssetsOpts = {
  fetch?: (url: string) => Promise<Response>;
  cdn?: string;
  assets?: Readonly<Record<string, string>>;
};

/**
 * Where the runtime files of `cacheRoot` are, as the `file:` URL with a
 * trailing slash that onnxruntime-web's `wasmPaths` takes. The folder is
 * created by `ensureOrtAssets`.
 */
export function ortAssetsPrefix(cacheRoot: string): string {
  return pathToFileURL(path.join(cacheRoot, `ort-${ORT_VERSION}`) + path.sep)
    .href;
}

const sha256 = (data: Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

/**
 * Make sure both files sit in `<cacheRoot>/ort-<version>/`, downloading
 * what is missing or does not match its pin. Returns the folder as a
 * `file:` URL with a trailing slash, the form onnxruntime-web's
 * `wasmPaths` takes.
 */
export async function ensureOrtAssets(
  cacheRoot: string,
  opts: OrtAssetsOpts = {},
): Promise<{ dir: string; prefix: string }> {
  const fetchFn = opts.fetch ?? ((url: string) => fetch(url));
  const cdn = opts.cdn ?? ORT_CDN;
  const assets = opts.assets ?? ORT_ASSETS;
  const dir = path.join(cacheRoot, `ort-${ORT_VERSION}`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  for (const [name, want] of Object.entries(assets)) {
    const file = path.join(dir, name);
    const cached = await fs.readFile(file).then(
      (buf) => sha256(buf) === want,
      () => false,
    );
    if (cached) continue;

    const res = await fetchFn(cdn + name);
    if (!res.ok)
      throw new Error(`ONNX runtime file ${name}: HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const got = sha256(buf);
    if (got !== want) {
      throw new Error(
        `ONNX runtime file ${name}: SHA-256 mismatch (expected ${want}, got ${got})`,
      );
    }
    const tmp = path.join(
      dir,
      `.${name}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      await fs.writeFile(tmp, buf, { mode: 0o600 });
      await fs.rename(tmp, file);
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  }
  return { dir, prefix: ortAssetsPrefix(cacheRoot) };
}
