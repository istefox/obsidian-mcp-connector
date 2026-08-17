/*
 * Unit tests for the decision half of scripts/link.ts.
 *
 * The filesystem half (`inspectLinkTarget`) is exercised by the real script
 * against scratch directories rather than mocked here: mocking `lstat` would
 * test the mock, and `lstat` versus `stat` is the whole point of that function.
 *
 * Importing this module at all depends on link.ts's `import.meta.main` guard.
 * Without it, this import would run the script — and with no argv, exit the
 * test process.
 */
import { describe, expect, test } from "bun:test";
import { decideLinkAction, type LinkTargetState } from "./link";

const REPO = "/Users/dev/Obsidian_MCP";
const TARGET = "/vault/.obsidian/plugins/mcp-tools-istefox";

const decide = (state: LinkTargetState) =>
  decideLinkAction(state, REPO, TARGET);

describe("decideLinkAction", () => {
  test("creates the link when nothing is there", () => {
    expect(decide({ kind: "absent" }).action).toBe("create");
  });

  test("accepts a symlink that points at this repo", () => {
    const d = decide({ kind: "symlink", target: REPO });
    expect(d.action).toBe("ok");
    expect(d.message).toContain(REPO);
  });

  test("REFUSES a real directory — the #468 case", () => {
    // The one that reported "Symlink already exists." and did nothing, because
    // existsSync is true for a directory. A copied plugin directory means a
    // build in this repo never reaches the vault.
    const d = decide({ kind: "directory" });
    expect(d.action).toBe("refuse");
    expect(d.message).toMatch(/COPY/);
  });

  test("the directory refusal names the data it will not touch", () => {
    // The refusal has to explain why it stops rather than deleting: the
    // directory holds live settings and a vector store.
    const { message } = decide({ kind: "directory" });
    expect(message).toContain("data.json");
    expect(message).toContain("embeddings/");
  });

  test("the directory refusal names the recovery step", () => {
    expect(decide({ kind: "directory" }).message).toMatch(/mv .*copy-backup/);
  });

  test("REFUSES a symlink pointing at another checkout", () => {
    // Also silent before this change, and just as stale-making as a copy.
    const d = decide({ kind: "symlink", target: "/Users/dev/other-checkout" });
    expect(d.action).toBe("refuse");
    expect(d.message).toContain("/Users/dev/other-checkout");
    expect(d.message).toContain(REPO);
  });

  test("a near-miss path is not treated as this repo", () => {
    // Substring thinking would accept a sibling checkout whose path merely
    // starts with ours.
    expect(decide({ kind: "symlink", target: `${REPO}-2` }).action).toBe(
      "refuse",
    );
  });

  test("REFUSES a file", () => {
    expect(decide({ kind: "file" }).action).toBe("refuse");
  });

  test("every refusal names the path it is refusing", () => {
    const states: LinkTargetState[] = [
      { kind: "directory" },
      { kind: "file" },
      { kind: "symlink", target: "/elsewhere" },
    ];
    for (const state of states) {
      expect(decide(state).message).toContain(TARGET);
    }
  });
});
