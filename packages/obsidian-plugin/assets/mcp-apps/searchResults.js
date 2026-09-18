import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps/app-with-deps";

const output = document.getElementById("output");
// Replaces the static placeholder as soon as the module starts, so
// that string surviving means unambiguously "this script never ran"
// — a CSP that refuses inline modules outright. A failure that stops
// results from arriving renders its own message here instead of
// leaving a stale state up; the two post-connect getters only cost
// what they own (theme, click-out), so those report to the console
// and leave the rest of the view running.
output.textContent = "Loading search results…";

// The view has no access to the server's TypeScript constants, so
// this key is a project-owned copy that must stay byte-identical
// to searchResultsPayload.ts's SEARCH_RESULTS_PAYLOAD_KEY.
const PAYLOAD_KEY = "io.github.istefox.mcp-connector/searchResults";

// Pure: no reference to `app`, the DOM or any variable outside its
// own arguments, so it is testable without a host or a document.
// `payload` is the row-list stamped onto a successful result's
// `_meta`; `content` is the result's own content array, present on
// every branch. Exactly one state applies: a payload with rows, a
// payload with none, no payload but message text (covers every
// isError branch, index_building included, per ADR-0018 D5), or
// neither.
export function renderSearchResultsView(payload, content) {
  if (payload && Array.isArray(payload.rows)) {
    if (payload.rows.length > 0) {
      return {
        state: "rows",
        vaultName: payload.vaultName,
        rows: payload.rows,
        totalRows: payload.totalRows,
        truncated: payload.truncated,
      };
    }
    return {
      state: "empty",
      message: "No results found in " + payload.vaultName + ".",
    };
  }
  const text =
    content && content[0] && typeof content[0].text === "string"
      ? content[0].text
      : undefined;
  if (text !== undefined) {
    return { state: "message", message: text };
  }
  return {
    state: "no-data",
    message: "No data received for this search.",
  };
}

let app;

const resultsList = document.getElementById("results-list");
const truncatedNote = document.getElementById("truncated-note");

function applyThemeFromContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

// Takes the path rather than the row: every read of the untrusted
// payload happens once, in createRowElement, and everything
// downstream works off the normalized value.
function revealPath(filePath, rowEl) {
  if (rowEl.dataset.pathRevealed) return;
  rowEl.dataset.pathRevealed = "true";
  const revealEl = document.createElement("code");
  revealEl.className = "search-results__row-path-reveal";
  revealEl.textContent = filePath;
  // Selecting the revealed path to copy it shouldn't re-trigger the
  // row's own click handler.
  revealEl.addEventListener("click", (event) => event.stopPropagation());
  rowEl.appendChild(revealEl);
}

// obsidian://open has no line parameter (ADR-0018 D9): the line is
// rendered as information only and never wired to a click target.
function createRowElement(row, vaultName, canOpenLinks) {
  // The row crosses a JSON round trip into this untyped module, and
  // JSON.stringify drops keys whose value is `undefined` — so a
  // producer that assigned `undefined` arrives here as a *missing*
  // key, which `!== null` waves straight through to `.toFixed()`.
  // Each field is checked for the type it is about to be used as, so
  // a wrong-typed one costs its own line and nothing else: the
  // optional three fall back to `null`, which is already the
  // "omit this" value the markup below is built around.
  const filePath = typeof row.filePath === "string" ? row.filePath : "";
  const excerpt = typeof row.excerpt === "string" ? row.excerpt : "";
  const heading = typeof row.heading === "string" ? row.heading : null;
  const score = typeof row.score === "number" ? row.score : null;
  const line = typeof row.line === "number" ? row.line : null;

  const li = document.createElement("li");
  li.className = "search-results__row";
  li.tabIndex = 0;
  li.setAttribute("role", "button");

  const pathEl = document.createElement("span");
  pathEl.className = "search-results__row-path";
  pathEl.textContent = filePath;
  li.appendChild(pathEl);

  const excerptEl = document.createElement("p");
  excerptEl.className = "search-results__row-excerpt";
  excerptEl.textContent = excerpt;
  li.appendChild(excerptEl);

  if (heading !== null || score !== null || line !== null) {
    const metaEl = document.createElement("div");
    metaEl.className = "search-results__row-meta";
    if (heading !== null) {
      const headingEl = document.createElement("span");
      headingEl.className = "search-results__row-heading";
      headingEl.textContent = heading;
      metaEl.appendChild(headingEl);
    }
    if (score !== null) {
      const scoreEl = document.createElement("span");
      scoreEl.className = "search-results__row-score";
      scoreEl.textContent = "score " + score.toFixed(2);
      metaEl.appendChild(scoreEl);
    }
    if (line !== null) {
      const lineEl = document.createElement("span");
      lineEl.className = "search-results__row-line";
      lineEl.textContent = "line " + line;
      metaEl.appendChild(lineEl);
    }
    li.appendChild(metaEl);
  }

  // Click-out degrades visibly rather than failing silently
  // (ADR-0018 D9): no openLinks capability, or an isError result,
  // reveals the vault-relative path instead of doing nothing.
  async function activate() {
    if (!canOpenLinks) {
      revealPath(filePath, li);
      return;
    }
    const url =
      "obsidian://open?vault=" +
      encodeURIComponent(vaultName) +
      "&file=" +
      encodeURIComponent(filePath);
    try {
      const result = await app.openLink({ url });
      if (result?.isError) revealPath(filePath, li);
    } catch (error) {
      // Bound and logged, unlike the two branches above. Those are the
      // expected shapes of "the host will not follow this link"; this
      // one is only reachable once openLinks was advertised, so a throw
      // here is a real failure. The user sees the same degradation
      // either way, so without this line the only difference between
      // "declined" and "broke" is invisible to whoever reports it.
      console.error("openLink threw for " + filePath, error);
      revealPath(filePath, li);
    }
  }

  li.addEventListener("click", activate);
  li.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  });

  return li;
}

function mountView(view, canOpenLinks) {
  resultsList.replaceChildren();
  resultsList.hidden = true;
  truncatedNote.hidden = true;
  output.classList.remove("search-results__status--message");

  if (view.state === "rows") {
    // Invariant: when this returns, exactly one of #output and
    // #results-list is visible — never neither. So the list is filled
    // while #output is still up, and the two are swapped only once
    // every row has survived. Hiding #output first, as this branch
    // used to, means a row that throws mid-loop leaves both hidden:
    // a blank frame, in a sandboxed iframe with no reachable
    // devtools, saying nothing about which of several causes it was.
    try {
      for (const row of view.rows) {
        resultsList.appendChild(
          createRowElement(row, view.vaultName, canOpenLinks),
        );
      }
    } catch (error) {
      // The list is still hidden from the reset above; drop the rows
      // built so far so a half-list cannot outlive the message.
      resultsList.replaceChildren();
      showFailure(
        "The search results arrived but could not be rendered.",
        error,
      );
      return;
    }
    // Reveal, then hide, never the reverse: should anything between
    // these two lines ever throw, the failure mode is both visible
    // rather than the blank frame this branch exists to rule out.
    resultsList.hidden = false;
    output.hidden = true;
    if (view.truncated) {
      truncatedNote.textContent =
        "Showing " + view.rows.length + " of " + view.totalRows + " results.";
      truncatedNote.hidden = false;
    }
    return;
  }

  output.hidden = false;
  output.textContent = view.message;
  if (view.state === "message") {
    output.classList.add("search-results__status--message");
  }
}

let canOpenLinks = false;

// Writes #output directly instead of going through mountView: this
// is the last thing the view gets to say, so it depends on the one
// element it is certain of rather than on the row list and the
// truncation note as well — a caller that has already touched those
// owns resetting them. The console line carries the stack that a
// one-line message cannot, for whoever has devtools open.
function showFailure(summary, error) {
  const reason = error instanceof Error ? error.message : String(error);
  output.hidden = false;
  output.classList.add("search-results__status--message");
  output.textContent = summary + " (" + reason + ")";
  console.error(summary, error);
}

async function start() {
  try {
    // autoResize stays at its default (true): a ResizeObserver reports
    // size changes for free. allowUnsafeEval stays at its default
    // (false): zod runs jitless, which is what the extension's default
    // CSP (no unsafe-eval) requires.
    app = new App(
      { name: "mcp-connector-search-results", version: "1.0.0" },
      {},
    );

    // ontoolresult/ontoolcancelled/onhostcontextchanged are one-shot
    // events: the App class warns if a handler is registered after
    // connect() resolves, because the host may already have sent the
    // notification. Every handler goes on before that await.
    app.ontoolresult = (params) => {
      const payload = params?._meta?.[PAYLOAD_KEY];
      mountView(
        renderSearchResultsView(payload, params?.content),
        canOpenLinks,
      );
    };
    app.ontoolcancelled = () => {
      mountView(
        { state: "message", message: "Search cancelled." },
        canOpenLinks,
      );
    };
    app.onhostcontextchanged = (ctx) => applyThemeFromContext(ctx);

    await app.connect();
  } catch (error) {
    showFailure(
      "The search results view loaded, but connecting to the host " +
        "failed: the ui/initialize handshake never completed, so no " +
        "results can arrive.",
      error,
    );
    return;
  }

  output.textContent = "Connected. Waiting for search results…";

  // Both getters sit past every catch above, so a throw here would
  // reject start()'s promise — and the top-level `await start()` has
  // no handler either, making it an unhandled rejection: no message,
  // no console line, and a view still claiming it is connected.
  // They are guarded apart because they fail differently and neither
  // is allowed to take the other down: unguarded, a throw from the
  // first also skipped the capability read. Results can still arrive
  // through either failure, so neither disturbs the status line.
  try {
    applyThemeFromContext(app.getHostContext());
  } catch (error) {
    console.error(
      "Could not apply the host theme; the view keeps its fallback " +
        "colours, which already follow the OS light/dark preference.",
      error,
    );
  }
  try {
    canOpenLinks = Boolean(app.getHostCapabilities()?.openLinks);
  } catch (error) {
    console.error(
      "Could not read the host capabilities; rows stay clickable but " +
        "reveal their vault-relative path instead of opening the note.",
      error,
    );
  }
}

// Awaited, not fire-and-forget: the page is not usable until this
// has either connected or said why it could not.
await start();
