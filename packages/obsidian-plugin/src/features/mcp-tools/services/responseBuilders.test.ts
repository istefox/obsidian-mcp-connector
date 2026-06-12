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
