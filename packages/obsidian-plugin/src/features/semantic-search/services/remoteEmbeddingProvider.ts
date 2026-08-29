/**
 * Remote embedding provider — any OpenAI-compatible `/v1/embeddings`
 * server: LM Studio, llama.cpp's server, Ollama's OpenAI shim,
 * text-embeddings-inference.
 *
 * Why this exists alongside the bundled ONNX providers: the bundled
 * ones are capped by what runs acceptably inside the Electron renderer
 * (MiniLM 384d, EmbeddingGemma 300M 768d). A GPU-backed server on the
 * same machine can serve a model an order of magnitude larger for the
 * same click, and the user may already be running one for other
 * plugins. Nothing here downloads or executes a model — this provider
 * is an HTTP client and nothing else, so `getModelSizeBytes()` is 0 and
 * the download-progress UI never applies to it.
 *
 * Three things this file is careful about:
 *
 * 1. **Normalization.** `NativeProviderImpl` scores with a bare dot
 *    product because every vector in the store is L2-normalized at
 *    embed time. Servers differ on whether they normalize (llama.cpp
 *    does by default, others do not, and it is not reported in the
 *    response), so every vector is normalized here. It is idempotent on
 *    an already-unit vector, so the cost is one pass and the risk of
 *    skipping it is silently wrong ranking.
 *
 * 2. **Asymmetric prompting.** Instruction-tuned retrieval embedders
 *    (F2LLM, e5, bge, Qwen3-Embedding) expect a prefix on the query and
 *    none on the passage. The server will not add it — it embeds
 *    exactly the string it is given — so the prefix is applied here,
 *    on the `"query"` role only. An empty instruction disables it.
 *
 * 3. **Batch alignment.** The indexer maps `embed(texts)[i]` back to
 *    `texts[i]` positionally. The OpenAI schema returns an `index` per
 *    item and does not promise ordering, so results are placed by
 *    `index`, and a response that does not cover the batch exactly is
 *    an error rather than a silently shifted index.
 *
 * The HTTP call is injected (`HttpPost`) for the same reason the ONNX
 * pipeline and the vault adapter are: so the batching, retry, ordering
 * and normalization logic is testable without a live server.
 */

import { requestUrl } from "obsidian";
import { logger } from "$/shared/logger";
import type { EmbeddingProvider, RemoteEmbeddingConfig } from "../types";

export type HttpResponse = { status: number; text: string };

export type HttpPost = (req: {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}) => Promise<HttpResponse>;

export type HttpGet = (req: {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}) => Promise<HttpResponse>;

/** Retries for transient failures (network error, 429, 5xx). */
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

/** How long a reachability verdict is trusted before re-probing. */
const AVAILABILITY_TTL_MS = 15_000;
/** Reachability probe timeout — short: this gates a skip, not a result. */
const AVAILABILITY_TIMEOUT_MS = 4_000;

/**
 * Accepts a server root, a `/v1` root, or a full endpoint URL, and
 * returns the endpoint. Users paste all three (LM Studio's own UI shows
 * the server root; other docs show the full path), and a 404 an hour
 * into a rebuild is a bad way to find out which one was expected.
 */
export function resolveEndpoint(
  baseUrl: string,
  path: "embeddings" | "models",
): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (new RegExp(`/${path}$`).test(trimmed)) return trimmed;
  // Already versioned ("/v1", "/v2", …) — just append.
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/${path}`;
  // A full endpoint for the *other* path: swap the tail.
  const other = path === "embeddings" ? "models" : "embeddings";
  if (new RegExp(`/${other}$`).test(trimmed)) {
    return trimmed.replace(new RegExp(`/${other}$`), `/${path}`);
  }
  return `${trimmed}/v1/${path}`;
}

function authHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/**
 * `requestUrl` (not `fetch`) because the Obsidian renderer enforces CORS
 * on `fetch` and a local server will not be sending an
 * `Access-Control-Allow-Origin` for `app://obsidian.md`. `requestUrl`
 * goes through Electron's net stack and is not subject to that.
 *
 * It has no timeout option, so every call is raced against one — a
 * server that accepts the connection and then stalls would otherwise
 * pin an indexer batch forever.
 */
function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

export const defaultHttpPost: HttpPost = async ({
  url,
  headers,
  body,
  timeoutMs,
}) => {
  const res = await withTimeout(
    requestUrl({ url, method: "POST", headers, body, throw: false }),
    timeoutMs,
    "embeddings request",
  );
  return { status: res.status, text: res.text };
};

export const defaultHttpGet: HttpGet = async ({ url, headers, timeoutMs }) => {
  const res = await withTimeout(
    requestUrl({ url, method: "GET", headers, throw: false }),
    timeoutMs,
    "request",
  );
  return { status: res.status, text: res.text };
};

/** 429 and 5xx are worth another try; 4xx is a config error, not a blip. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Turn a failed response into a message a user can act on. The raw body
 * from a local inference server is usually one JSON line with the real
 * reason ("model not loaded", "context length exceeded") and is far more
 * useful than the status code alone.
 */
function describeFailure(url: string, res: HttpResponse): string {
  const body = res.text?.slice(0, 400) ?? "";
  let detail = body;
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (parsed?.error) {
      detail =
        typeof parsed.error === "string"
          ? parsed.error
          : ((parsed.error as { message?: string }).message ?? body);
    }
  } catch {
    // Not JSON — the raw text is the best detail available.
  }
  if (res.status === 404) {
    return `${url} returned 404. Check the base URL and that the model id exists on the server. ${detail}`.trim();
  }
  return `${url} returned ${res.status}. ${detail}`.trim();
}

/**
 * Parse an OpenAI-shaped embeddings response into a dense array aligned
 * with the request batch. Exported for tests — this is where a
 * misbehaving server turns into a wrong index rather than an error.
 */
export function parseEmbeddingsResponse(
  raw: string,
  expectedCount: number,
): Float32Array[] {
  let parsed: { data?: Array<{ embedding?: unknown; index?: unknown }> };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error(`embeddings response was not JSON: ${raw.slice(0, 200)}`);
  }
  const data = parsed?.data;
  if (!Array.isArray(data)) {
    throw new Error("embeddings response had no `data` array");
  }
  if (data.length !== expectedCount) {
    throw new Error(
      `embeddings response returned ${data.length} vectors for ${expectedCount} inputs`,
    );
  }

  const out = new Array<Float32Array | undefined>(expectedCount);
  data.forEach((item, position) => {
    // `index` is the spec's ordering field; fall back to array position
    // for servers that omit it.
    const idx =
      typeof item?.index === "number" && Number.isInteger(item.index)
        ? item.index
        : position;
    if (idx < 0 || idx >= expectedCount) {
      throw new Error(`embeddings response had out-of-range index ${idx}`);
    }
    if (out[idx]) {
      throw new Error(`embeddings response repeated index ${idx}`);
    }
    out[idx] = toUnitVector(item?.embedding);
  });

  const filled = out.filter((v): v is Float32Array => v !== undefined);
  if (filled.length !== expectedCount) {
    throw new Error("embeddings response did not cover every input index");
  }
  return filled;
}

/**
 * Coerce one `embedding` field to an L2-normalized Float32Array.
 * Accepts the float array from the spec and the base64 form some
 * servers emit when they ignore `encoding_format: "float"`.
 */
function toUnitVector(embedding: unknown): Float32Array {
  let vec: Float32Array;
  if (Array.isArray(embedding)) {
    vec = new Float32Array(embedding.length);
    for (let i = 0; i < embedding.length; i++) {
      const n = embedding[i];
      if (typeof n !== "number" || !Number.isFinite(n)) {
        throw new Error("embeddings response contained a non-finite value");
      }
      vec[i] = n;
    }
  } else if (typeof embedding === "string") {
    // base64 little-endian float32
    const bin = atob(embedding);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes.length % 4 !== 0) {
      throw new Error("base64 embedding was not a whole number of float32s");
    }
    vec = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
    vec = new Float32Array(vec); // copy off the transient buffer
  } else {
    throw new Error("embeddings response item had no usable `embedding`");
  }

  if (vec.length === 0)
    throw new Error("embeddings response had an empty vector");
  return normalizeInPlace(vec);
}

/**
 * L2-normalize so the store's dot-product scoring is cosine. A
 * zero-norm vector (an all-whitespace chunk on some servers) is left
 * alone rather than divided by zero: it scores 0 against everything,
 * which is the correct outcome.
 */
export function normalizeInPlace(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm === 0 || !Number.isFinite(norm)) return vec;
  // Already unit within float error — skip the write pass.
  if (Math.abs(norm - 1) < 1e-6) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i] / norm;
  return vec;
}

/**
 * Apply the asymmetric retrieval prompt. Queries get
 * `Instruct: <instruction>\nQuery: <text>`; documents are always sent
 * bare, which is what every instruction-tuned retrieval embedder's
 * model card specifies. An empty instruction means symmetric use.
 */
export function applyRolePrompt(
  text: string,
  role: "document" | "query",
  instruction: string,
): string {
  if (role !== "query") return text;
  const instr = instruction.trim();
  if (!instr) return text;
  return `Instruct: ${instr}\nQuery: ${text}`;
}

export type RemoteProviderDeps = {
  post?: HttpPost;
  get?: HttpGet;
};

class RemoteEmbeddingProviderImpl implements EmbeddingProvider {
  readonly providerKey: string;
  readonly dimensions: number;
  readonly maxInputTokens: number;

  private readonly post: HttpPost;
  private readonly get: HttpGet;
  private availability: { ok: boolean; at: number } | null = null;

  constructor(
    providerKey: string,
    private readonly cfg: RemoteEmbeddingConfig,
    deps: RemoteProviderDeps = {},
  ) {
    this.providerKey = providerKey;
    this.dimensions = cfg.dimensions;
    this.maxInputTokens = cfg.maxInputTokens;
    this.post = deps.post ?? defaultHttpPost;
    this.get = deps.get ?? defaultHttpGet;
  }

  /**
   * No backend probe: the context window belongs to the server, which
   * does not advertise it over this API. The configured value is the
   * chunker's budget and the user owns it.
   */
  getMaxInputTokens(): Promise<number> {
    return Promise.resolve(this.maxInputTokens);
  }

  /** Nothing is downloaded into the vault — the model lives server-side. */
  getModelSizeBytes(): number {
    return 0;
  }

  /**
   * Cheap reachability check. The indexer calls this before a rebuild
   * and skips the pass when it fails, which is the behavior we want: a
   * server that is simply not running yet should postpone indexing, not
   * wipe or half-fill the store.
   *
   * Cached briefly so a per-file live-index burst does not turn into a
   * probe per file.
   */
  async isAvailable(): Promise<boolean> {
    const now = Date.now();
    if (this.availability && now - this.availability.at < AVAILABILITY_TTL_MS) {
      return this.availability.ok;
    }
    let ok = false;
    try {
      const res = await this.get({
        url: resolveEndpoint(this.cfg.baseUrl, "models"),
        headers: authHeaders(this.cfg.apiKey),
        timeoutMs: AVAILABILITY_TIMEOUT_MS,
      });
      // Any HTTP answer means something is listening and reachable. A
      // 401/404 here is a config problem the embed call will report with
      // a far better message than a bare "unavailable".
      ok = res.status > 0;
    } catch (err) {
      logger.warn("remote embeddings: server unreachable", {
        providerKey: this.providerKey,
        baseUrl: this.cfg.baseUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      ok = false;
    }
    this.availability = { ok, at: Date.now() };
    return ok;
  }

  async embed(
    texts: string[],
    role: "document" | "query",
  ): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const prompted = texts.map((t) =>
      applyRolePrompt(t, role, this.cfg.queryInstruction),
    );

    const out: Float32Array[] = [];
    // Sequential batches on purpose: the server is one GPU. Parallel
    // requests do not make it finish sooner and do make it OOM.
    for (let i = 0; i < prompted.length; i += this.cfg.batchSize) {
      const batch = prompted.slice(i, i + this.cfg.batchSize);
      const vectors = await this.embedBatch(batch);
      for (const v of vectors) {
        if (v.length !== this.dimensions) {
          throw new Error(
            `remote embeddings: model "${this.cfg.model}" returned ${v.length}-d vectors, but this index was built at ${this.dimensions}-d. Re-run "Test connection" in settings to re-detect the width.`,
          );
        }
        out.push(v);
      }
    }
    return out;
  }

  private async embedBatch(batch: string[]): Promise<Float32Array[]> {
    const url = resolveEndpoint(this.cfg.baseUrl, "embeddings");
    const body = JSON.stringify({
      model: this.cfg.model,
      input: batch,
      encoding_format: "float",
    });

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.post({
          url,
          headers: authHeaders(this.cfg.apiKey),
          body,
          timeoutMs: this.cfg.timeoutMs,
        });
        if (res.status >= 200 && res.status < 300) {
          // A successful call is also fresh evidence of reachability.
          this.availability = { ok: true, at: Date.now() };
          return parseEmbeddingsResponse(res.text, batch.length);
        }
        const message = describeFailure(url, res);
        if (!isRetryableStatus(res.status)) throw new Error(message);
        lastError = new Error(message);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        // A non-retryable failure was already thrown above with its
        // message; re-throw it rather than burning the retry budget on
        // a config error that will fail identically three times.
        if (
          /returned 4\d\d/.test(e.message) &&
          !/returned 429/.test(e.message)
        ) {
          throw e;
        }
        lastError = e;
      }
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_DELAY_MS * attempt);
        logger.warn("remote embeddings: retrying batch", {
          providerKey: this.providerKey,
          attempt,
          error: lastError?.message,
        });
      }
    }
    throw lastError ?? new Error("remote embeddings: request failed");
  }
}

export function createRemoteEmbeddingProvider(
  providerKey: string,
  cfg: RemoteEmbeddingConfig,
  deps: RemoteProviderDeps = {},
): EmbeddingProvider {
  return new RemoteEmbeddingProviderImpl(providerKey, cfg, deps);
}

/**
 * One-shot embed of a probe string, used to discover the model's vector
 * width before any store exists. Called by the settings "Test
 * connection" button and, at plugin load, when the remote provider is
 * selected but no width has been cached yet.
 *
 * Returns the width rather than storing it: the caller owns settings.
 */
export async function probeRemoteDimensions(
  cfg: Pick<RemoteEmbeddingConfig, "baseUrl" | "model" | "apiKey">,
  opts: { timeoutMs?: number; post?: HttpPost } = {},
): Promise<number> {
  const post = opts.post ?? defaultHttpPost;
  const url = resolveEndpoint(cfg.baseUrl, "embeddings");
  const res = await post({
    url,
    headers: authHeaders(cfg.apiKey ?? ""),
    body: JSON.stringify({
      model: cfg.model,
      input: ["dimension probe"],
      encoding_format: "float",
    }),
    timeoutMs: opts.timeoutMs ?? 30_000,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(describeFailure(url, res));
  }
  const [vector] = parseEmbeddingsResponse(res.text, 1);
  return vector.length;
}

/**
 * Model ids the server currently exposes. Best-effort convenience for
 * the settings UI — a server that does not implement `/v1/models`
 * simply yields an empty list and the user types the id.
 */
export async function listRemoteModels(
  cfg: Pick<RemoteEmbeddingConfig, "baseUrl" | "apiKey">,
  opts: { timeoutMs?: number; get?: HttpGet } = {},
): Promise<string[]> {
  const get = opts.get ?? defaultHttpGet;
  const url = resolveEndpoint(cfg.baseUrl, "models");
  const res = await get({
    url,
    headers: authHeaders(cfg.apiKey ?? ""),
    timeoutMs: opts.timeoutMs ?? 10_000,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(describeFailure(url, res));
  }
  try {
    const parsed = JSON.parse(res.text) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(parsed?.data)) return [];
    return parsed.data
      .map((m) => (typeof m?.id === "string" ? m.id : null))
      .filter((id): id is string => id !== null)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
