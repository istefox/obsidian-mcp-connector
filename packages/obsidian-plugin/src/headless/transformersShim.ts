// Stands in for `@huggingface/transformers` in the headless bundle: the
// library as it is, with the headless defaults on `pipeline` (see
// pipelineDefaults.ts). bun.headless.config.ts sends every import of the
// package here except this file's own, which reaches the real one.
import * as real from "@huggingface/transformers";
import { withHeadlessDefaults } from "./pipelineDefaults";

export * from "@huggingface/transformers";
export const pipeline = withHeadlessDefaults(real.pipeline);
