import { describe, expect, test } from "bun:test";
import { errorJson, successJson, successText } from "./responseBuilders";

describe("responseBuilders", () => {
  test("errorJson keeps the error/errorCode/extras key order", () => {
    const result = errorJson("File not found", "file_not_found", {
      path: "a.md",
    });
    expect(result.isError).toBe(true);
    // Byte-identical to the inline JSON.stringify({error, errorCode, path})
    // shape used by the property tools.
    expect(result.content[0].text).toBe(
      JSON.stringify({
        error: "File not found",
        errorCode: "file_not_found",
        path: "a.md",
      }),
    );
  });

  test("successText wraps plain text without isError", () => {
    const result = successText("OK");
    expect(result).toEqual({ content: [{ type: "text", text: "OK" }] });
    expect("isError" in result).toBe(false);
  });

  test("successJson serializes compact, no indentation", () => {
    const result = successJson({ a: 1 });
    expect(result.content[0].text).toBe('{"a":1}');
  });
});

describe("successJson — structuredContent is opt-in (#627)", () => {
  test("default: the payload travels once, in the text block", () => {
    const result = successJson({ a: 1 });
    expect("structuredContent" in result).toBe(false);
    expect(result.content[0].text).toBe('{"a":1}');
  });

  test("default: arrays and primitives carry no structuredContent either", () => {
    for (const v of [[1, 2], 42, "hello", true, null, {}]) {
      expect("structuredContent" in successJson(v)).toBe(false);
    }
  });

  test("structured: plain object sets structuredContent to the object itself", () => {
    const result = successJson({ a: 1 }, { structured: true });
    expect(result.structuredContent).toEqual({ a: 1 });
    expect(result.content[0].text).toBe('{"a":1}');
  });

  test("structured: array is wrapped as { result: [...] }", () => {
    const result = successJson([1, 2], { structured: true });
    expect(result.structuredContent).toEqual({ result: [1, 2] });
    expect(result.content[0].text).toBe("[1,2]");
  });

  test("structured: primitives are wrapped as { result }", () => {
    expect(successJson(42, { structured: true }).structuredContent).toEqual({
      result: 42,
    });
    expect(successJson("hi", { structured: true }).structuredContent).toEqual({
      result: "hi",
    });
    expect(successJson(true, { structured: true }).structuredContent).toEqual({
      result: true,
    });
  });

  test("structured: null is wrapped as { result: null } and text stays 'null'", () => {
    const result = successJson(null, { structured: true });
    expect(result.structuredContent).toEqual({ result: null });
    expect(result.content[0].text).toBe("null");
  });

  test("undefined omits structuredContent even when opted in", () => {
    const result = successJson(undefined, { structured: true });
    expect("structuredContent" in result).toBe(false);
    // text must remain a valid JSON string, never the JS value undefined
    // (which would be dropped from the wire object on serialization).
    expect(typeof result.content[0].text).toBe("string");
    expect(result.content[0].text).toBe("null");
  });

  test("structured: empty and nested objects pass through verbatim", () => {
    expect(successJson({}, { structured: true }).structuredContent).toEqual({});
    expect(
      successJson({ x: { y: [1] } }, { structured: true }).structuredContent,
    ).toEqual({ x: { y: [1] } });
  });

  test("errorJson carries no structuredContent", () => {
    expect("structuredContent" in errorJson("e", "c")).toBe(false);
  });

  test("successText carries no structuredContent", () => {
    expect("structuredContent" in successText("t")).toBe(false);
  });
});
