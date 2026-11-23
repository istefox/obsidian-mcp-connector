import { describe, expect, test } from "bun:test";
import { VECTOR_PROBE_KEY } from "../src/features/semantic-search/services/vectorProbeHook";
import { vectorProbeBundleProblem } from "./vectorProbeBundleCheck";

const plain = 'var a=1;globalThis["somethingElse"]=a;';
const withHook = `var a=1;globalThis["${VECTOR_PROBE_KEY}"]={pipelineFactory:a};`;

describe("vectorProbeBundleProblem", () => {
  test("an ordinary build with no hook is fine", () => {
    expect(vectorProbeBundleProblem(plain, false)).toBeNull();
  });

  test("an ordinary build that holds the hook is refused", () => {
    expect(vectorProbeBundleProblem(withHook, false)).toBe(
      "main.js holds the vector probe hook without --vector-probe",
    );
  });

  test("a probe build that holds the hook is fine", () => {
    expect(vectorProbeBundleProblem(withHook, true)).toBeNull();
  });

  test("a probe build that lost the hook is refused", () => {
    expect(vectorProbeBundleProblem(plain, true)).toBe(
      "--vector-probe was passed but main.js has no vector probe hook",
    );
  });
});
