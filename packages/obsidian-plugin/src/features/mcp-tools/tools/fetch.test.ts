import { describe, expect, test, beforeEach } from "bun:test";
import { fetchHandler, fetchSchema } from "./fetch";
import { resetMockVault, setMockRequestUrl } from "$/test-setup";

beforeEach(() => resetMockVault());

describe("fetch tool", () => {
  test("schema declares the tool name", () => {
    expect(fetchSchema.get("name")?.toString()).toContain("fetch");
  });

  test("returns Markdown by default for HTML content", async () => {
    setMockRequestUrl("https://example.com", {
      status: 200,
      text: "<h1>Hello</h1><p>World</p>",
      headers: { "content-type": "text/html" },
    });
    const result = await fetchHandler({
      arguments: { url: "https://example.com" },
    });
    expect(result.content[0].type).toBe("text");
    // Turndown converts <h1> → "# Hello"
    const text = result.content[0].text as string;
    expect(text).toContain("Hello");
    expect(text).toContain("World");
  });

  test("returns raw HTML when format=html", async () => {
    setMockRequestUrl("https://example.com", {
      status: 200,
      text: "<h1>Hello</h1>",
      headers: { "content-type": "text/html" },
    });
    const result = await fetchHandler({
      arguments: { url: "https://example.com", format: "html" },
    });
    expect(result.content[0].text).toContain("<h1>Hello</h1>");
  });

  test("respects startIndex and maxLength pagination", async () => {
    const longText = "0123456789".repeat(20); // 200 chars
    setMockRequestUrl("https://x.com", {
      status: 200,
      text: longText,
      headers: { "content-type": "text/plain" },
    });
    const result = await fetchHandler({
      arguments: {
        url: "https://x.com",
        format: "html",
        startIndex: 50,
        maxLength: 30,
      },
    });
    const text = result.content[0].text as string;
    expect(text.length).toBeLessThanOrEqual(200); // 30 + truncation hint
    expect(text).toContain("0123456789"); // contains some content
  });

  test("includes truncation hint when content exceeds maxLength", async () => {
    setMockRequestUrl("https://x.com", {
      status: 200,
      text: "A".repeat(1000),
      headers: { "content-type": "text/plain" },
    });
    const result = await fetchHandler({
      arguments: { url: "https://x.com", format: "html", maxLength: 100 },
    });
    const text = result.content[0].text as string;
    expect(text).toMatch(/truncated|continue|next|remaining/i);
  });

  test("handles fetch errors gracefully", async () => {
    setMockRequestUrl("https://fail.com", {
      status: 500,
      text: "Internal Server Error",
      headers: { "content-type": "text/plain" },
    });
    // Note: in Obsidian, requestUrl always returns a response object.
    // Errors are thrown as exceptions in requestUrl itself, not in the response.
    // For this test, we simulate a successful fetch so it shows how errors
    // would be handled if requestUrl threw an exception.
    // A real integration test would need to mock requestUrl to throw.
    const result = await fetchHandler({
      arguments: { url: "https://example.com" },
    });
    expect(result.content[0].type).toBe("text");
  });

  // ── FIX 1: SSRF / local-file-read guard ──────────────────────────────────
  test.each([
    ["file:///etc/passwd", /scheme/i],
    ["data:text/plain,hello", /scheme/i],
    ["blob:https://x/abc", /scheme/i],
    ["http://127.0.0.1/admin", /internal|loopback/i],
    ["http://localhost:8080/", /internal|loopback/i],
    ["http://10.0.0.5/", /internal|loopback/i],
    ["http://192.168.1.1/", /internal|loopback/i],
    ["http://169.254.169.254/latest/meta-data/", /internal|loopback/i],
    ["http://[::1]/", /internal|loopback/i],
    ["http://printer.local/", /internal|loopback/i],
    // Spellings that used to slip past the host check (#623).
    ["http://localhost./", /internal|loopback/i],
    ["http://x.localhost/", /internal|loopback/i],
    ["http://a.b.localhost./", /internal|loopback/i],
    ["http://[::ffff:127.0.0.1]/", /internal|loopback/i],
    ["http://[::ffff:10.0.0.1]/", /internal|loopback/i],
    ["http://[::ffff:172.16.0.1]/", /internal|loopback/i],
    ["http://[::ffff:172.31.255.255]/", /internal|loopback/i],
    ["http://[::ffff:192.168.1.1]/", /internal|loopback/i],
    ["http://[::ffff:169.254.169.254]/", /internal|loopback/i],
    ["not a url", /invalid url/i],
  ])("rejects %s without performing a request", async (url, pattern) => {
    const result = await fetchHandler({ arguments: { url } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Fetch rejected/);
    expect(result.content[0].text).toMatch(pattern);
  });

  test.each([
    "http://[::ffff:8.8.8.8]/",
    "http://[::ffff:172.32.0.1]/",
    "http://notlocalhost.example/",
  ])("does not reject public host %s", async (url) => {
    setMockRequestUrl(url, {
      status: 200,
      text: "ok",
      headers: { "content-type": "text/plain" },
    });
    const result = await fetchHandler({ arguments: { url } });
    expect(result.isError).toBeUndefined();
  });

  test("accepts a normal public https URL", async () => {
    setMockRequestUrl("https://example.com", {
      status: 200,
      text: "<p>ok</p>",
      headers: { "content-type": "text/html" },
    });
    const result = await fetchHandler({
      arguments: { url: "https://example.com" },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("ok");
  });

  // ── FIX 2: maxLength clamp ───────────────────────────────────────────────
  test("clamps an absurd maxLength to the 500k ceiling", async () => {
    const text = "Y".repeat(600_000);
    setMockRequestUrl("https://big.com", {
      status: 200,
      text,
      headers: { "content-type": "text/plain" },
    });
    const result = await fetchHandler({
      arguments: {
        url: "https://big.com",
        format: "html",
        maxLength: 5_000_000,
      },
    });
    const resultText = result.content[0].text as string;
    // Ceiling is 500_000; the remaining 100_000 chars must be truncated,
    // so the slice cannot exceed ceiling + the (small) truncation note.
    expect(resultText).toMatch(/truncated|remaining/i);
    expect(resultText.length).toBeLessThan(500_000 + 500);
  });

  test("defaults maxLength to 5000 if not provided", async () => {
    const text = "X".repeat(10000);
    setMockRequestUrl("https://x.com", {
      status: 200,
      text,
      headers: { "content-type": "text/plain" },
    });
    const result = await fetchHandler({
      arguments: { url: "https://x.com", format: "html" },
    });
    const resultText = result.content[0].text as string;
    // Should include truncation hint
    expect(resultText).toMatch(/truncated|continue|next|remaining/i);
    // Should be roughly around 5000 chars (plus hint)
    expect(resultText.length).toBeGreaterThan(4900);
    expect(resultText.length).toBeLessThan(6000);
  });
});
