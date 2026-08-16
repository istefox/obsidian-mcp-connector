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
  // Attribute-order-tolerant: the element is found by carrying
  // id="output" among its attributes, in any position, rather than by
  // requiring a bare <pre id="output"> with nothing else on the tag. A
  // <pre> with a different id, or none at all, still does not match —
  // only the text content changes here, never what counts as a match.
  const match = html.match(/<pre\b[^>]*\bid="output"[^>]*>([^<]*)<\/pre>/);
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
  // The resolved module namespace object, so a test can reach a named
  // export (`renderSearchResultsView`) without a second Blob-URL-import
  // path of its own.
  moduleExports: Record<string, unknown>;
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

  let moduleExports: Record<string, unknown> = {};
  try {
    const blob = new Blob([moduleSource], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      // The module has a top-level `await app.connect()`, so this import
      // does not settle until the whole handshake (or its failure) has
      // already happened — nothing to poll for.
      moduleExports = (await import(url)) as Record<string, unknown>;
    } finally {
      URL.revokeObjectURL(url);
    }
  } finally {
    restore();
  }

  return { calls, outputTextContent: output.textContent, moduleExports };
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
  // The module writes #output twice before any tool result arrives: once
  // synchronously on load ("Loading search results…") and once after
  // connect() resolves ("Connected. Waiting for search results…"). Either
  // way it no longer reads the static placeholder, so that string keeps
  // meaning only "never ran" (CSP blocked the blob: import, etc) rather
  // than being indistinguishable from "connected but idle".
  test("no longer shows the static placeholder once the handshake has completed", async () => {
    const initialText = extractInitialOutputText(SEARCH_RESULTS_APP_HTML);
    const { outputTextContent } = await runShellModule(SEARCH_RESULTS_APP_HTML);
    expect(outputTextContent).not.toBe(initialText);
  });
});

type RenderSearchResultsView = (
  payload: unknown,
  content: unknown,
) => { state: string; [key: string]: unknown };

// The handshake in runShellModule is real work — a schema-valid
// ui/initialize round trip plus parsing the whole ext-apps bundle — and
// renderSearchResultsView is pure, so one load is shared across every test
// below instead of repeating it per assertion. Nothing here mutates
// anything the function reads, so sharing carries no cross-test coupling.
let cachedRenderSearchResultsView: RenderSearchResultsView | undefined;
async function getRenderSearchResultsView(): Promise<RenderSearchResultsView> {
  if (!cachedRenderSearchResultsView) {
    const { moduleExports } = await runShellModule(SEARCH_RESULTS_APP_HTML);
    cachedRenderSearchResultsView =
      moduleExports.renderSearchResultsView as RenderSearchResultsView;
  }
  return cachedRenderSearchResultsView;
}

describe("search results view — row renderer (R-09, R-10)", () => {
  test("rows: a row with score, heading and line keeps all of them; a row with none of them still carries filePath and excerpt, with the rest left `null`", async () => {
    const renderSearchResultsView = await getRenderSearchResultsView();
    const payload = {
      vaultName: "My Vault",
      totalRows: 2,
      truncated: false,
      rows: [
        {
          filePath: "notes/alpha.md",
          excerpt: "alpha excerpt",
          line: 4,
          score: 0.87,
          heading: "Alpha heading",
        },
        {
          filePath: "notes/beta.md",
          excerpt: "beta excerpt",
          line: null,
          score: null,
          heading: null,
        },
      ],
    };

    const view = renderSearchResultsView(payload, undefined);

    expect(view.state).toBe("rows");
    expect(view.vaultName).toBe("My Vault");
    expect(view.totalRows).toBe(2);
    expect(view.truncated).toBe(false);

    const rows = view.rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);

    expect(rows[0]).toEqual({
      filePath: "notes/alpha.md",
      excerpt: "alpha excerpt",
      line: 4,
      score: 0.87,
      heading: "Alpha heading",
    });

    // The three optional fields survive as `null`, never `undefined` and
    // never the string "null" — the DOM layer's own per-field omission
    // (`row.score !== null`, etc.) depends on that exact value.
    expect(rows[1].filePath).toBe("notes/beta.md");
    expect(rows[1].excerpt).toBe("beta excerpt");
    expect(rows[1].line).toBeNull();
    expect(rows[1].score).toBeNull();
    expect(rows[1].heading).toBeNull();
  });

  test("zero rows: renders the explicit empty state", async () => {
    const renderSearchResultsView = await getRenderSearchResultsView();
    const payload = {
      vaultName: "My Vault",
      totalRows: 0,
      truncated: false,
      rows: [],
    };

    const view = renderSearchResultsView(payload, undefined);

    expect(view.state).toBe("empty");
    // The message names the vault the search ran against — the payload
    // this function receives carries no query string at all (see
    // searchResultsPayload.ts's SearchResultsPayload type and both
    // projectors), so "naming the query" is not something this function
    // has the data to do. Recorded as a finding in the report rather than
    // asserted here as if it were true.
    expect(view.message).toBe("No results found in My Vault.");
  });

  test("isError: no payload key at all, so content[0].text is rendered as the message", async () => {
    const renderSearchResultsView = await getRenderSearchResultsView();
    const content = [
      { type: "text", text: "Semantic index is still building." },
    ];

    const view = renderSearchResultsView(undefined, content);

    expect(view.state).toBe("message");
    expect(view.message).toBe("Semantic index is still building.");
  });

  test("neither payload nor content: the neutral no-data state, without throwing", async () => {
    const renderSearchResultsView = await getRenderSearchResultsView();

    expect(() => renderSearchResultsView(undefined, undefined)).not.toThrow();

    const view = renderSearchResultsView(undefined, undefined);
    expect(view.state).toBe("no-data");
    expect(view.message).toBe("No data received for this search.");
  });
});

describe("search results view — excerpts are never markup (R-09)", () => {
  test("the module never assigns innerHTML", () => {
    const moduleSource = extractModuleScript(SEARCH_RESULTS_APP_HTML);
    expect(moduleSource).not.toContain("innerHTML");
  });

  test("an excerpt containing markup survives renderSearchResultsView as a literal string", async () => {
    const renderSearchResultsView = await getRenderSearchResultsView();
    const malicious = "<img src=x onerror=alert(1)>";
    const payload = {
      vaultName: "My Vault",
      totalRows: 1,
      truncated: false,
      rows: [
        {
          filePath: "notes/gamma.md",
          excerpt: malicious,
          line: null,
          score: null,
          heading: null,
        },
      ],
    };

    const view = renderSearchResultsView(payload, undefined);
    const rows = view.rows as Array<Record<string, unknown>>;
    expect(rows[0].excerpt).toBe(malicious);
  });
});
