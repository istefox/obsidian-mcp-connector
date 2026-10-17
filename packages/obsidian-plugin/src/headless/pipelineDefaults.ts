/**
 * What the headless server changes about the feature-extraction pipeline the
 * shared semantic search builds, without a seam in the shared code. The
 * headless bundle points its `@huggingface/transformers` imports at
 * `transformersShim.ts`, whose `pipeline` is the library's wrapped by
 * `withHeadlessDefaults`.
 *
 * - The weights are 8-bit quantized (`q8`) unless the caller names a
 *   precision: 23 MB against 90 MB, and faster on a CPU. The desktop
 *   passes none for its native model and gets the library default.
 * - A batch of texts is embedded one text at a time. Inference runs on the
 *   main thread, so a batch holds up the event loop for as long as it
 *   takes, and with mean pooling and masking a text's vector does not
 *   depend on how it was batched. The pieces are joined into the one
 *   `[batch, dimension]` tensor the caller expects.
 */

type Output = { data: Float32Array; dims?: number[] };
type Pipe = (input: string | string[], options?: unknown) => Promise<Output>;
type PipelineFactory = (
  task: unknown,
  model: unknown,
  options?: Record<string, unknown>,
) => Promise<unknown>;

/** The precision the headless server loads the native model at. */
export const HEADLESS_DTYPE = "q8";

/** `pipe`, with an array of several texts run as that many calls of one. */
export function embedOneAtATime(pipe: Pipe): Pipe {
  const wrapped: Pipe = async (input, options) => {
    if (!Array.isArray(input) || input.length < 2) return pipe(input, options);
    const rows: Float32Array[] = [];
    for (const text of input) {
      // Sequential on purpose: each call is a turn for the event loop.
      rows.push((await pipe(text, options)).data);
    }
    const width = rows[0].length;
    if (rows.some((row) => row.length !== width)) {
      throw new Error("embedding rows differ in length");
    }
    const data = new Float32Array(rows.length * width);
    rows.forEach((row, i) => data.set(row, i * width));
    return { data, dims: [rows.length, width] };
  };
  return Object.assign(wrapped, pipe);
}

export function withHeadlessDefaults<
  F extends (...args: never[]) => Promise<unknown>,
>(pipeline: F): F {
  const create = pipeline as unknown as PipelineFactory;
  const wrapped = async (
    task: unknown,
    model: unknown,
    options?: Record<string, unknown>,
  ) => {
    const pipe = await create(task, model, {
      ...options,
      dtype: options?.dtype ?? HEADLESS_DTYPE,
    });
    return typeof pipe === "function" ? embedOneAtATime(pipe as Pipe) : pipe;
  };
  return wrapped as unknown as F;
}
