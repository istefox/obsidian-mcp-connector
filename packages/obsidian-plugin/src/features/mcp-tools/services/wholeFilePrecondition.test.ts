import { describe, expect, test } from "bun:test";
import { checkWholeFilePrecondition } from "./wholeFilePrecondition";

describe("checkWholeFilePrecondition", () => {
  test("no expectedContent and require off: proceeds", () => {
    expect(
      checkWholeFilePrecondition({
        action: "overwrite",
        currentContent: "anything",
        expectedContent: undefined,
        require: false,
        readTool: "get_active_file",
      }),
    ).toBeNull();
  });

  test("no expectedContent and require on: refuses, naming the read tool", () => {
    const msg = checkWholeFilePrecondition({
      action: "delete",
      currentContent: "x",
      expectedContent: undefined,
      require: true,
      readTool: "get_vault_file",
    });
    expect(msg).toContain("Refusing to delete");
    expect(msg).toContain("expectedContent");
    expect(msg).toContain("get_vault_file");
  });

  test("matching content: proceeds", () => {
    expect(
      checkWholeFilePrecondition({
        action: "delete",
        currentContent: "hello\n",
        expectedContent: "hello\n",
        require: true,
        readTool: "get_vault_file",
      }),
    ).toBeNull();
  });

  test("CRLF vs LF and trailing newline differences are tolerated", () => {
    expect(
      checkWholeFilePrecondition({
        action: "overwrite",
        currentContent: "a\r\nb\r\n",
        expectedContent: "a\nb",
        require: false,
        readTool: "get_active_file",
      }),
    ).toBeNull();
  });

  test("mismatch on overwrite: refuses and points at the patch tool", () => {
    const msg = checkWholeFilePrecondition({
      action: "overwrite",
      currentContent: "edited",
      expectedContent: "original",
      require: false,
      readTool: "get_active_file",
    });
    expect(msg).toContain("Refusing to overwrite");
    expect(msg).toContain("get_active_file");
    expect(msg).toContain("patch tool");
  });

  test("mismatch on delete: refuses without the patch hint", () => {
    const msg = checkWholeFilePrecondition({
      action: "delete",
      currentContent: "edited",
      expectedContent: "original",
      require: false,
      readTool: "get_vault_file",
    });
    expect(msg).toContain("Refusing to delete");
    expect(msg).not.toContain("patch tool");
  });
});
