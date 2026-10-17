import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureOrtAssets, ORT_ASSETS, ORT_CDN, ORT_VERSION } from "./ortAssets";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ort-assets-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const GLUE = "export default 1;";
const WASM = "\0asm-bytes";
const ASSETS = { "glue.mjs": sha(GLUE), "core.wasm": sha(WASM) };
const BODIES: Record<string, string> = { "glue.mjs": GLUE, "core.wasm": WASM };
const CDN = "https://cdn.test/dist/";

/** A fetch serving BODIES, recording what was asked for. */
function fakeFetch(overrides: Record<string, () => Response> = {}) {
  const urls: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    urls.push(url);
    const name = url.slice(CDN.length);
    return overrides[name]?.() ?? new Response(BODIES[name]);
  };
  return { fetch, urls };
}
const dirOf = () => path.join(root, `ort-${ORT_VERSION}`);

describe("ensureOrtAssets", () => {
  test("downloads both files once into a private folder and returns the file: URL", async () => {
    const { fetch, urls } = fakeFetch();
    const { dir, prefix } = await ensureOrtAssets(root, {
      fetch,
      cdn: CDN,
      assets: ASSETS,
    });
    expect(urls.sort()).toEqual([`${CDN}core.wasm`, `${CDN}glue.mjs`]);
    expect(dir).toBe(dirOf());
    expect(prefix).toBe(`file://${dirOf()}/`);
    expect(fs.readFileSync(path.join(dir, "glue.mjs"), "utf8")).toBe(GLUE);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, "glue.mjs")).mode & 0o777).toBe(0o600);
  });

  test("leaves nothing but the two files behind (atomic write)", async () => {
    await ensureOrtAssets(root, {
      fetch: fakeFetch().fetch,
      cdn: CDN,
      assets: ASSETS,
    });
    expect(fs.readdirSync(dirOf()).sort()).toEqual(["core.wasm", "glue.mjs"]);
  });

  test("an already cached, matching file is not fetched again", async () => {
    await ensureOrtAssets(root, {
      fetch: fakeFetch().fetch,
      cdn: CDN,
      assets: ASSETS,
    });
    const again = fakeFetch();
    await ensureOrtAssets(root, {
      fetch: again.fetch,
      cdn: CDN,
      assets: ASSETS,
    });
    expect(again.urls).toEqual([]);
  });

  test("a cached file that no longer matches its pin is fetched again", async () => {
    await ensureOrtAssets(root, {
      fetch: fakeFetch().fetch,
      cdn: CDN,
      assets: ASSETS,
    });
    fs.writeFileSync(path.join(dirOf(), "core.wasm"), "truncated");
    const again = fakeFetch();
    await ensureOrtAssets(root, {
      fetch: again.fetch,
      cdn: CDN,
      assets: ASSETS,
    });
    expect(again.urls).toEqual([`${CDN}core.wasm`]);
    expect(fs.readFileSync(path.join(dirOf(), "core.wasm"), "utf8")).toBe(WASM);
  });

  test("a hash mismatch is refused and no file, partial or temporary, is left", async () => {
    const { fetch } = fakeFetch({ "glue.mjs": () => new Response("tampered") });
    await expect(
      ensureOrtAssets(root, { fetch, cdn: CDN, assets: ASSETS }),
    ).rejects.toThrow("SHA-256 mismatch");
    expect(fs.readdirSync(dirOf())).toEqual([]);
  });

  test("a mismatch does not replace a good cached file", async () => {
    await ensureOrtAssets(root, {
      fetch: fakeFetch().fetch,
      cdn: CDN,
      assets: ASSETS,
    });
    // The cached file is fine, so the bad CDN answer is never asked for.
    const bad = fakeFetch({ "glue.mjs": () => new Response("tampered") });
    await ensureOrtAssets(root, { fetch: bad.fetch, cdn: CDN, assets: ASSETS });
    expect(fs.readFileSync(path.join(dirOf(), "glue.mjs"), "utf8")).toBe(GLUE);
  });

  test("an HTTP error is reported with the file name and status", async () => {
    const { fetch } = fakeFetch({
      "core.wasm": () => new Response("no", { status: 503 }),
    });
    await expect(
      ensureOrtAssets(root, { fetch, cdn: CDN, assets: ASSETS }),
    ).rejects.toThrow("core.wasm: HTTP 503");
  });

  test("a failed attempt can be repeated", async () => {
    const offline = async (): Promise<Response> => {
      throw new Error("offline");
    };
    await expect(
      ensureOrtAssets(root, { fetch: offline, cdn: CDN, assets: ASSETS }),
    ).rejects.toThrow("offline");
    await ensureOrtAssets(root, {
      fetch: fakeFetch().fetch,
      cdn: CDN,
      assets: ASSETS,
    });
    expect(fs.readdirSync(dirOf()).sort()).toEqual(["core.wasm", "glue.mjs"]);
  });
});

describe("pinned assets", () => {
  const dist = path.join(
    path.dirname(require.resolve("onnxruntime-web/package.json")),
    "dist",
  );

  test("match the installed onnxruntime-web, so a version bump cannot leave stale pins", () => {
    expect(
      JSON.parse(fs.readFileSync(path.join(dist, "..", "package.json"), "utf8"))
        .version,
    ).toBe(ORT_VERSION);
    for (const [name, want] of Object.entries(ORT_ASSETS)) {
      const got = createHash("sha256")
        .update(fs.readFileSync(path.join(dist, name)))
        .digest("hex");
      expect(got).toBe(want);
    }
  });

  test("come from the same CDN version the desktop uses", () => {
    expect(ORT_CDN).toBe(
      "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/",
    );
  });
});
