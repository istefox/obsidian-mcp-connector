/**
 * What `obsidian eval` loads (#680): `require("<path>/vector-probe.cjs")`
 * inside a vault whose plugin was built with `--vector-probe`.
 *
 * A run downloads and loads several models, which outlasts one eval
 * call. `start` returns at once and `status` is polled; the report is
 * also written to disk, so a closed terminal loses nothing.
 */
import fs from "node:fs";
import {
  VECTOR_PROBE_KEY,
  type VectorProbeHook,
} from "../../src/features/semantic-search/services/vectorProbeHook";
import { formatReport } from "./formatReport";
import { runVectorProbe, type ProbeReport } from "./runVectorProbe";
import { PROBE_NOTES, PROBE_QUERIES } from "./corpus";
import { PROBE_SENTENCES } from "./sentences";

type State = {
  phase: "running" | "done" | "failed";
  log: string[];
  report?: ProbeReport;
  text?: string;
  error?: string;
};

const STATE_KEY = "__mcpConnectorVectorProbeRun";
const globals = globalThis as Record<string, unknown>;

export type StartOptions = {
  /** Absolute path prefix: `<out>.txt` and `<out>.json` are written. */
  out?: string;
  /** Model labels to run. Absent runs every model. */
  only?: string[];
};

export function start(options: StartOptions = {}): string {
  const hook = globals[VECTOR_PROBE_KEY] as VectorProbeHook | undefined;
  if (!hook) {
    return (
      "No vector probe hook in this vault: the plugin was not built with " +
      "--vector-probe, was not reloaded after the build, or semantic search is off."
    );
  }
  const current = globals[STATE_KEY] as State | undefined;
  if (current?.phase === "running")
    return "A probe run is already in progress.";

  const state: State = { phase: "running", log: [] };
  globals[STATE_KEY] = state;
  runVectorProbe(hook, {
    sentences: PROBE_SENTENCES,
    notes: PROBE_NOTES,
    queries: PROBE_QUERIES,
    only: options.only,
    log: (line) => state.log.push(line),
  }).then(
    (report) => {
      state.report = report;
      state.text = formatReport(report);
      state.phase = "done";
      if (options.out) {
        fs.writeFileSync(`${options.out}.txt`, state.text);
        fs.writeFileSync(
          `${options.out}.json`,
          JSON.stringify(report, null, 2),
        );
      }
    },
    (error: unknown) => {
      state.error = error instanceof Error ? error.message : String(error);
      state.phase = "failed";
    },
  );
  return "Vector probe started. Poll status().";
}

export function status(): string {
  const state = globals[STATE_KEY] as State | undefined;
  if (!state) return "No probe run in this session.";
  if (state.phase === "failed") return `FAILED: ${state.error}`;
  if (state.phase === "done") return state.text ?? "";
  return ["RUNNING", ...state.log].join("\n");
}
