import { describe, expect, test } from "bun:test";
import {
  checkCreateBinaryPrecondition,
  checkCreatePrecondition,
} from "./createPrecondition";

describe("checkCreatePrecondition (ADR-0022 — create_vault_file)", () => {
  test("path does not exist, expectedContent absent: creates regardless of the toggle", () => {
    for (const require of [false, true]) {
      expect(
        checkCreatePrecondition({
          exists: false,
          currentContent: "",
          expectedContent: undefined,
          require,
        }),
      ).toBeNull();
    }
  });

  test('path does not exist, expectedContent "": creates regardless of the toggle', () => {
    // Empty is what a non-existent file holds — not a stale expectation.
    for (const require of [false, true]) {
      expect(
        checkCreatePrecondition({
          exists: false,
          currentContent: "",
          expectedContent: "",
          require,
        }),
      ).toBeNull();
    }
  });

  test("path does not exist, expectedContent non-empty: refused regardless of the toggle", () => {
    for (const require of [false, true]) {
      const refusal = checkCreatePrecondition({
        exists: false,
        currentContent: "",
        expectedContent: "the note I thought was already there",
        require,
      });
      expect(refusal).toContain("Refusing to create");
      expect(refusal).toContain("no file exists");
    }
  });

  test("path exists, expectedContent absent, toggle off: overwrites (unchanged behaviour)", () => {
    expect(
      checkCreatePrecondition({
        exists: true,
        currentContent: "current content",
        expectedContent: undefined,
        require: false,
      }),
    ).toBeNull();
  });

  test("path exists, expectedContent absent, toggle on: refused", () => {
    const refusal = checkCreatePrecondition({
      exists: true,
      currentContent: "current content",
      expectedContent: undefined,
      require: true,
    });
    expect(refusal).toContain("requires a write precondition");
    expect(refusal).toContain("expectedContent");
  });

  test("path exists, expectedContent matches: overwrites regardless of the toggle", () => {
    for (const require of [false, true]) {
      expect(
        checkCreatePrecondition({
          exists: true,
          currentContent: "current content",
          expectedContent: "current content",
          require,
        }),
      ).toBeNull();
    }
  });

  test("a match survives whitespace drift the caller cannot see", () => {
    expect(
      checkCreatePrecondition({
        exists: true,
        currentContent: "\ncurrent content  \n",
        expectedContent: "current content\r\n",
        require: false,
      }),
    ).toBeNull();
  });

  test("path exists, expectedContent mismatches: refused regardless of the toggle, names the cause and the recovery", () => {
    for (const require of [false, true]) {
      const refusal = checkCreatePrecondition({
        exists: true,
        currentContent: "what the human just wrote",
        expectedContent: "what the agent read ten minutes ago",
        require,
      });
      expect(refusal).toContain("Refusing to overwrite");
      expect(refusal).toContain("get_vault_file");
      expect(refusal).toContain("not a bug");
      expect(refusal).toContain("patch_vault_file");
    }
  });

  test("path exists, expectedContent empty against non-empty content: still refused (not treated as absent)", () => {
    expect(
      checkCreatePrecondition({
        exists: true,
        currentContent: "current content",
        expectedContent: "",
        require: false,
      }),
    ).toContain("Refusing to overwrite");
  });
});

describe("checkCreateBinaryPrecondition (ADR-0022 — create_vault_binary_file)", () => {
  test("path does not exist: creates regardless of overwrite or the toggle", () => {
    for (const overwrite of [undefined, true, false]) {
      for (const require of [false, true]) {
        expect(
          checkCreateBinaryPrecondition({ exists: false, overwrite, require }),
        ).toBeNull();
      }
    }
  });

  test("path exists, overwrite absent, toggle off: overwrites (unchanged behaviour)", () => {
    expect(
      checkCreateBinaryPrecondition({
        exists: true,
        overwrite: undefined,
        require: false,
      }),
    ).toBeNull();
  });

  test("path exists, overwrite absent, toggle on: refused", () => {
    const refusal = checkCreateBinaryPrecondition({
      exists: true,
      overwrite: undefined,
      require: true,
    });
    expect(refusal).toContain("requires a write precondition");
    expect(refusal).toContain("overwrite: true");
  });

  test("path exists, overwrite: true: overwrites regardless of the toggle", () => {
    for (const require of [false, true]) {
      expect(
        checkCreateBinaryPrecondition({
          exists: true,
          overwrite: true,
          require,
        }),
      ).toBeNull();
    }
  });

  test("path exists, overwrite: false: refused regardless of the toggle", () => {
    for (const require of [false, true]) {
      const refusal = checkCreateBinaryPrecondition({
        exists: true,
        overwrite: false,
        require,
      });
      expect(refusal).toContain("Refusing to overwrite");
      expect(refusal).toContain("overwrite: true");
    }
  });
});
