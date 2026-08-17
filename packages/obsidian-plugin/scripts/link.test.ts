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

  test("the directory refusal names the RESTORE step, into the repo root", () => {
    // `mv` alone is half a recovery and the wrong half to stop at: the link
    // makes the repo root the plugin directory, so settings and vector store
    // left behind in the vault are simply gone. The first version of this
    // message said `mv` and stopped, and the step nobody prints is the step
    // nobody performs.
    const { message } = decide({ kind: "directory" });
    expect(message).toContain(`data.json" "${REPO}/"`);
    expect(message).toContain(`embeddings" "${REPO}/"`);
  });

  test("the restore step copies FROM the backup, not from the live directory", () => {
    // Sourcing the copy from `targetPath` would read the symlink this script
    // is about to create — that is, the repo root — and copy a file onto
    // itself, or nothing at all.
    const { message } = decide({ kind: "directory" });
    expect(message).toContain(`${TARGET}.copy-backup/data.json`);
    expect(message).not.toMatch(/cp "[^"]*plugins\/mcp-tools-istefox\/data/);
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
