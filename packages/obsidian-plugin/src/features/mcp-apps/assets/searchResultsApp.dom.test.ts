/**
 * Drives the generated page's own inline module through a synthetic host,
 * without a browser and without jsdom/happy-dom (neither is in this
 * project's dependency tree). The module is extracted from the same
 * constant the resource reader serves and executed for real, as an ES
 * module imported from a Blob URL — Bun supports both `Blob` and
 * `URL.createObjectURL` natively, so this is genuine execution of the
 * shipped code, not a reimplementation of it.
 *
 * The stand-in `window`/`document` only cover the surface the page
 * actually touches: `getElementById`, `addEventListener("message", …)`,
 * `postMessage`, and the handful of globals `setupSizeChangedNotifications`
 * needs so it does not throw. Nothing here parses HTML into a tree or
 * renders anything — that would be a much larger claim than this test
 * makes.
 */
import { describe, expect, test } from "bun:test";
import { SEARCH_RESULTS_APP_HTML } from "./searchResultsAppSource";

function extractModuleScript(html: string): string {
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error(
      'generated page has no <script type="module"> block to execute',
    );
  }
  return match[1];
}

function extractBundleSource(html: string): string {
  const match = html.match(/id="mcp-apps-bundle">([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error("generated page has no #mcp-apps-bundle script block");
  }
  return match[1];
}

function extractInitialOutputText(html: string): string {
  const match = html.match(/<pre id="output">([^<]*)<\/pre>/);
  if (!match) {
    throw new Error("generated page has no #output element");
  }
  return match[1];
}

/**
 * Swaps in the given globals for the duration of a run and hands back a
 * restorer. `bun test` runs every file in one process, so leaving a stray
 * `window` behind would leak into whatever test file runs next.
 */
function installGlobals(values: Record<string, unknown>): () => void {
  const target = globalThis as unknown as Record<string, unknown>;
  const previous = new Map<string, { existed: boolean; value: unknown }>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, { existed: key in target, value: target[key] });
    target[key] = value;
  }
  return () => {
    for (const [key, entry] of previous) {
      if (entry.existed) target[key] = entry.value;
      else delete target[key];
    }
  };
}

interface CapturedMessage {
  method?: string;
  id?: number;
  [key: string]: unknown;
}

interface ShellRunResult {
  calls: CapturedMessage[];
  outputTextContent: string;
}

/**
 * Runs the page's module script against a fake host that replies to
 * `ui/initialize` with a minimal, schema-valid result — echoing back
 * whatever `id` the library sent, so nothing here needs to reproduce the
 * SDK's own id-generation scheme. `ui/notifications/tool-result` is never
 * sent, so `app.ontoolresult` never fires — this is the "connected, idle"
 * state, not the "got results" one.
 */
async function runShellModule(html: string): Promise<ShellRunResult> {
  const moduleSource = extractModuleScript(html);
  const bundleSource = extractBundleSource(html);
  const output = { textContent: extractInitialOutputText(html) };

  const calls: CapturedMessage[] = [];
  let messageListener:
    | ((event: { data: unknown; source: unknown }) => void)
    | undefined;

  const fakeParent: Record<string, unknown> = {};
  fakeParent.postMessage = (message: CapturedMessage) => {
    calls.push(message);
    if (message.method === "ui/initialize") {
      const id = message.id;
      queueMicrotask(() => {
        messageListener?.({
          data: {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2026-01-26",
              hostInfo: { name: "test-host", version: "0.0.0" },
              hostCapabilities: {},
              hostContext: {},
            },
          },
          source: fakeParent,
        });
      });
    }
  };

  const restore = installGlobals({
    window: {
      parent: fakeParent,
      innerWidth: 100,
      addEventListener: (
        type: string,
        handler: (event: { data: unknown; source: unknown }) => void,
      ) => {
        if (type === "message") messageListener = handler;
      },
      removeEventListener: (type: string) => {
        if (type === "message") messageListener = undefined;
      },
    },
    document: {
      getElementById: (id: string) => {
        if (id === "mcp-apps-bundle") return { textContent: bundleSource };
        if (id === "output") return output;
        return null;
      },
      documentElement: {},
      body: {},
    },
    // Only present so setupSizeChangedNotifications() (called because
    // autoResize defaults true) doesn't throw. Its rAF callback is never
    // invoked here, so no ui/notifications/size-changed call is produced.
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: () => 0,
  });

  try {
    const blob = new Blob([moduleSource], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      // The module has a top-level `await app.connect()`, so this import
      // does not settle until the whole handshake (or its failure) has
      // already happened — nothing to poll for.
      await import(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  } finally {
    restore();
  }

  return { calls, outputTextContent: output.textContent };
}

describe("search results view — handshake (R-07)", () => {
  test("sends ui/initialize, then ui/notifications/initialized, once the host replies", async () => {
    const { calls } = await runShellModule(SEARCH_RESULTS_APP_HTML);
    expect(calls.map((call) => call.method)).toEqual([
      "ui/initialize",
      "ui/notifications/initialized",
    ]);
  });
});

describe("search results view — idle output text", () => {
  // Currently red: the module only ever writes #output from inside
  // app.ontoolresult, so a page that loaded and completed the handshake
  // but has not yet received a tool result looks byte-identical to a page
  // that never ran at all (CSP blocked the blob: import, etc). Both show
  // "waiting for a tool result…". Making the connected-but-idle state say
  // something different is what would make the static string mean only
  // "never ran".
  test("no longer shows the static placeholder once the handshake has completed", async () => {
    const initialText = extractInitialOutputText(SEARCH_RESULTS_APP_HTML);
    const { outputTextContent } = await runShellModule(SEARCH_RESULTS_APP_HTML);
    expect(outputTextContent).not.toBe(initialText);
  });
});
