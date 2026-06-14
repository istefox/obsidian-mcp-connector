import { describe, expect, test } from "bun:test";
import {
  errorJson,
  errorText,
  successJson,
  successText,
} from "./responseBuilders";

describe("responseBuilders", () => {
  test("errorText wraps the message and sets isError", () => {
    expect(errorText("File not found: a.md")).toEqual({
      content: [{ type: "text", text: "File not found: a.md" }],
      isError: true,
    });
  });

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

describe("successJson — structuredContent dual-emit", () => {
  test("plain object sets structuredContent to the object itself", () => {
    const result = successJson({ a: 1 });
    expect(result.structuredContent).toEqual({ a: 1 });
  });

  test("text is byte-identical for plain object", () => {
    const result = successJson({ a: 1 });
    expect(result.content[0].text).toBe('{"a":1}');
  });

  test("array is wrapped as { result: [...] } in structuredContent", () => {
    const result = successJson([1, 2]);
    expect(result.structuredContent).toEqual({ result: [1, 2] });
    expect(result.content[0].text).toBe("[1,2]");
  });

  test("number primitive is wrapped as { result: 42 }", () => {
    const result = successJson(42);
    expect(result.structuredContent).toEqual({ result: 42 });
  });

  test("string primitive is wrapped as { result: 'hello' }", () => {
    const result = successJson("hello");
    expect(result.structuredContent).toEqual({ result: "hello" });
  });

  test("boolean primitive is wrapped as { result: true }", () => {
    const result = successJson(true);
    expect(result.structuredContent).toEqual({ result: true });
  });

  test("null is wrapped as { result: null } and text stays 'null'", () => {
    const result = successJson(null);
    expect(result.structuredContent).toEqual({ result: null });
    expect(result.content[0].text).toBe("null");
  });

  test("undefined omits structuredContent entirely", () => {
    const result = successJson(undefined);
    expect("structuredContent" in result).toBe(false);
    // text must remain a valid JSON string, never the JS value undefined
    // (which would be dropped from the wire object on serialization).
    expect(typeof result.content[0].text).toBe("string");
    expect(result.content[0].text).toBe("null");
  });

  test("empty object passes through as structuredContent", () => {
    const result = successJson({});
    expect(result.structuredContent).toEqual({});
  });

  test("nested object passes through verbatim", () => {
    const result = successJson({ x: { y: [1] } });
    expect(result.structuredContent).toEqual({ x: { y: [1] } });
  });

  test("errorJson carries no structuredContent", () => {
    expect("structuredContent" in errorJson("e", "c")).toBe(false);
  });

  test("errorText carries no structuredContent", () => {
    expect("structuredContent" in errorText("e")).toBe(false);
  });

  test("successText carries no structuredContent", () => {
    expect("structuredContent" in successText("t")).toBe(false);
  });
});
