import { describe, expect, test } from "bun:test";
import { fsErrorMessage } from "./fsErrorMessage";

/** A Node-shaped fs error: Error with a string `code` and the absolute
 * host path embedded in the message, exactly what `fs` rejections carry. */
function errnoError(code: string, message: string): Error {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe("fsErrorMessage", () => {
  test("maps known errno codes to vault-relative phrases", () => {
    expect(
      fsErrorMessage(
        errnoError(
          "ENOENT",
          "ENOENT: no such file or directory, open '/Users/someone/Vault/Note.md'",
        ),
      ),
    ).toBe("file or directory does not exist");
    expect(
      fsErrorMessage(
        errnoError("EACCES", "EACCES: permission denied, open '/home/u/v/x'"),
      ),
    ).toBe("permission denied");
    expect(
      fsErrorMessage(
        errnoError(
          "EPERM",
          "EPERM: operation not permitted, rename 'C:\\v\\a'",
        ),
      ),
    ).toBe("permission denied");
    expect(
      fsErrorMessage(errnoError("ENOSPC", "ENOSPC: no space left on device")),
    ).toBe("no space left on device");
  });

  // Regression guard in the spirit of #88: whatever the input shape, the
  // rendered message never carries an absolute host path.
  test("never lets an absolute host path through", () => {
    const shapes = [
      errnoError(
        "EIO",
        "EIO: i/o error, write '/Users/someone/Library/CloudStorage/Vault/n.md'",
      ),
      new Error(
        "something broke at /Users/someone/Vault/Secret/n.md while writing",
      ),
      new Error("rename 'C:\\Users\\someone\\Vault\\a.md' failed"),
      new Error("UNC path \\\\server\\share\\vault\\a.md unreachable"),
      "raw string with /home/someone/vault/x.md inside",
    ];
    for (const e of shapes) {
      const msg = fsErrorMessage(e);
      expect(msg).not.toMatch(/\/Users\/|\/home\/|C:\\|\\\\server/);
      expect(msg).not.toContain("someone");
    }
  });

  test("a quoted path with spaces is replaced whole", () => {
    expect(
      fsErrorMessage(new Error("open '/home/jane/My Vault/sub' failed")),
    ).toBe("open '<path>' failed");
    expect(
      fsErrorMessage(
        new Error(
          "rename '/Users/a b/Vault/x.md' -> '/Users/a b/Vault/y z.md'",
        ),
      ),
    ).toBe("rename '<path>' -> '<path>'");
    expect(
      fsErrorMessage(new Error("open 'C:\\Users\\Jane Doe\\Vault\\n.md'")),
    ).toBe("open '<path>'");
    expect(
      fsErrorMessage(new Error("open '/home/o'Brien/My Vault/n.md'")),
    ).toBe("open '<path>'");
  });

  test("an unknown errno names the failure class without the trailer", () => {
    expect(
      fsErrorMessage(errnoError("EIO", "EIO: i/o error, write '/abs/path'")),
    ).toBe("file system error (EIO)");
  });

  test("a path-free message passes through untouched", () => {
    expect(fsErrorMessage(new Error("vault is read-only right now"))).toBe(
      "vault is read-only right now",
    );
    expect(fsErrorMessage("plain failure")).toBe("plain failure");
    expect(fsErrorMessage(42)).toBe("42");
  });

  test("vault-relative paths survive scrubbing", () => {
    expect(
      fsErrorMessage(new Error("could not write Notes/Daily/2026-10-16.md")),
    ).toBe("could not write Notes/Daily/2026-10-16.md");
  });
});
