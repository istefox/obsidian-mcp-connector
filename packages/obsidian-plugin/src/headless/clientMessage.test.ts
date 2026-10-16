import { describe, expect, test } from "bun:test";
import {
  RUNTIME_FILES_FAILED,
  codeOf,
  fixedMessage,
  isOwnRuntimeFailure,
  leadingErrno,
} from "./clientMessage";

describe("codeOf", () => {
  test("reads a plain code from the error or its cause", () => {
    expect(codeOf(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(
      "EACCES",
    );
    expect(
      codeOf(
        Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("x"), { code: "ENOTFOUND" }),
        }),
      ),
    ).toBe("ENOTFOUND");
  });

  test.each([
    ["no code", new Error("x")],
    ["a numeric code", Object.assign(new Error("x"), { code: 13 })],
    [
      "a code that holds a path",
      Object.assign(new Error("x"), { code: "/home/jane/Private Cache" }),
    ],
    ["a lower-case code", Object.assign(new Error("x"), { code: "denied" })],
    ["a string", "EACCES"],
    ["null", null],
  ])("finds none in %s", (_name, err) => {
    expect(codeOf(err)).toBeUndefined();
  });
});

describe("leadingErrno", () => {
  test("reads the errno a Node fs message starts with, and no other text", () => {
    expect(leadingErrno("EACCES: permission denied, open '/a b/c'")).toBe(
      "EACCES",
    );
    expect(
      leadingErrno("open '/a b/c' failed: EACCES: denied"),
    ).toBeUndefined();
    expect(leadingErrno("Error: EACCES: denied")).toBeUndefined();
    expect(leadingErrno("")).toBeUndefined();
  });
});

describe("fixedMessage", () => {
  test("names what failed, the code if it is plain, and the log", () => {
    expect(fixedMessage("it failed", "EIO")).toBe(
      "it failed (EIO). Details are in the server log.",
    );
    expect(fixedMessage("it failed")).toBe(
      "it failed. Details are in the server log.",
    );
    expect(fixedMessage("it failed", "/home/jane")).toBe(
      "it failed. Details are in the server log.",
    );
  });
});

describe("isOwnRuntimeFailure", () => {
  test("accepts the fixed runtime-file message, with or without a code", () => {
    for (const code of [undefined, "EEXIST"]) {
      expect(
        isOwnRuntimeFailure(
          `Semantic search failed: ${fixedMessage(RUNTIME_FILES_FAILED, code)}`,
        ),
      ).toBe(true);
    }
  });

  test("refuses anything with more in it", () => {
    for (const message of [
      `Semantic search failed: ${RUNTIME_FILES_FAILED}: open '/a b'`,
      `Semantic search failed: ${RUNTIME_FILES_FAILED} (/a b). Details are in the server log.`,
      `Semantic search failed: ${RUNTIME_FILES_FAILED}. Details are in the server log. /a b`,
      `${RUNTIME_FILES_FAILED}. Details are in the server log.`,
    ]) {
      expect(isOwnRuntimeFailure(message)).toBe(false);
    }
  });
});
