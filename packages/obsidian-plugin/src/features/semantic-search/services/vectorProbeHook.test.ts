import { describe, expect, test } from "bun:test";
import type { PipelineFactoryWithProgress } from "./embedder";
import {
  installVectorProbeHook,
  VECTOR_PROBE_KEY,
  type VectorProbeHook,
} from "./vectorProbeHook";

describe("vector probe hook", () => {
  test("installs the factory under the key the build looks for", () => {
    const pipelineFactory: PipelineFactoryWithProgress = async () => {
      throw new Error("not called");
    };
    const hook: VectorProbeHook = {
      pipelineFactory,
      machineBackend: async () => "wasm",
      models: [],
    };
    const target: Record<string, unknown> = {};

    installVectorProbeHook(target, hook);

    expect(Object.keys(target)).toEqual([VECTOR_PROBE_KEY]);
    expect(target[VECTOR_PROBE_KEY]).toBe(hook);
  });

  test("the test run is an ordinary build: nothing installed the hook", () => {
    expect(process.env.MCP_VECTOR_PROBE).not.toBe("1");
    expect(VECTOR_PROBE_KEY in globalThis).toBe(false);
  });
});
