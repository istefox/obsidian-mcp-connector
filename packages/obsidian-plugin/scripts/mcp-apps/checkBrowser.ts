import assert from "node:assert/strict";
import { chromium } from "playwright";
import { SEARCH_RESULTS_APP_HTML } from "../../src/features/mcp-apps/assets/searchResultsAppSource";

// Pi MCP Adapter 2.34.0 resource policy. In particular, no blob: or unsafe-eval.
const csp =
  "default-src 'none'; sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-same-origin; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; media-src 'self' data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'self'";
const host = `<iframe src="/app" sandbox="allow-scripts allow-same-origin"></iframe>
<script>
window.methods = [];
window.addEventListener('message', e => {
  if (e.source !== document.querySelector('iframe').contentWindow) return;
  const m = e.data;
  window.methods.push(m.method);
  if (m.method === 'ui/initialize') e.source.postMessage({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params.protocolVersion,hostInfo:{name:'regression-host',version:'1'},hostCapabilities:{openLinks:{}},hostContext:{theme:'light'}}}, '*');
  if (m.method === 'ui/open-link') e.source.postMessage({jsonrpc:'2.0',id:m.id,result:{}}, '*');
});
</script>`;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    return new URL(request.url).pathname === "/app"
      ? new Response(SEARCH_RESULTS_APP_HTML, {
          headers: {
            "Content-Type": "text/html",
            "Content-Security-Policy": csp,
          },
        })
      : new Response(host, { headers: { "Content-Type": "text/html" } });
  },
});
let browser;
try {
  browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
  });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`http://127.0.0.1:${server.port}`);
  const frame = page.frames().find((f) => f.url().endsWith("/app"))!;
  await frame.waitForFunction(
    () => /Connected\.|failed to import/.test(document.body.innerText),
    null,
    { timeout: 10000 },
  );
  assert.match(
    await frame.locator("body").innerText(),
    /Connected\./,
    errors.join("\n"),
  );
  const notify = async (method: string, params: unknown) =>
    page.evaluate(
      ({ method, params }) => {
        document
          .querySelector("iframe")!
          .contentWindow!.postMessage({ jsonrpc: "2.0", method, params }, "*");
      },
      { method, params },
    );
  const key = "io.github.istefox.mcp-connector/searchResults";
  const row = {
    filePath: "demo.md",
    excerpt: "CSP regression",
    line: 1,
    score: null,
    heading: null,
  };
  await notify("ui/notifications/tool-result", {
    content: [],
    _meta: {
      [key]: { vaultName: "test", rows: [row], totalRows: 1, truncated: false },
    },
  });
  await frame.locator(".search-results__row").waitFor();
  await frame.locator(".search-results__row").click();
  await page.waitForFunction(() =>
    (window as any).methods.includes("ui/open-link"),
  );
  await notify("ui/notifications/tool-result", {
    content: [],
    _meta: {
      [key]: { vaultName: "test", rows: [], totalRows: 0, truncated: false },
    },
  });
  await frame.waitForFunction(() =>
    document.body.innerText.includes("No results found"),
  );
  await notify("ui/notifications/tool-result", {
    content: [{ type: "text", text: "index_building: test" }],
    isError: true,
  });
  await frame.waitForFunction(() =>
    document.body.innerText.includes("index_building"),
  );
  await notify("ui/notifications/tool-cancelled", { reason: "test" });
  await frame.waitForFunction(() =>
    document.body.innerText.includes("Search cancelled"),
  );
  await notify("ui/notifications/host-context-changed", { theme: "dark" });
  await frame.waitForFunction(
    () => document.documentElement.style.colorScheme === "dark",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      status: "passed",
      browser: browser.version(),
      checks: [
        "CSP",
        "initialize",
        "rows",
        "open-link",
        "empty",
        "error",
        "cancel",
        "theme",
      ],
    }),
  );
} finally {
  await browser?.close();
  server.stop(true);
}
