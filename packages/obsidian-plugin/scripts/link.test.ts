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
import {
  backupPathFor,
  decideICloudTarget,
  decideLinkAction,
  findShadowingPlugins,
  type LinkTargetState,
} from "./link";

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
    //
    // The literal was `${TARGET}.copy-backup/data.json` until the backup moved
    // out of plugins/. The property under test is unchanged — source is the
    // backup, never the live path — so it is asserted through `backupPathFor`
    // rather than through a second hand-written copy of the layout, which is
    // what made this assertion go stale in the first place.
    const { message } = decide({ kind: "directory" });
    expect(message).toContain(`${backupPathFor(TARGET)}/data.json`);
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

  test("the iCloud question does not reach the copied-directory refusal", () => {
    // The two decisions are separate functions for exactly this reason: a
    // `directory` is refused on a fact, and no environment variable may turn
    // that into a link. If these ever merge, this is what notices.
    expect(decide({ kind: "directory" }).action).toBe("refuse");
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

describe("backupPathFor", () => {
  test("the backup goes OUTSIDE plugins/, one level up", () => {
    // The whole point, and the thing the first version of this message got
    // wrong. A backup beside the link declares the same id in its manifest,
    // Obsidian keys plugins by that id, and the copy wins — measured on
    // 2026-08-17, where it served 2.0.1 across a full restart.
    expect(backupPathFor(TARGET)).toBe(
      "/vault/.obsidian/mcp-tools-istefox.copy-backup",
    );
  });

  test("the backup is never a sibling of the link", () => {
    const pluginsDir = TARGET.slice(0, TARGET.lastIndexOf("/"));
    expect(backupPathFor(TARGET).startsWith(`${pluginsDir}/`)).toBe(false);
  });

  test("the directory refusal prints that path, not a sibling", () => {
    const { message } = decide({ kind: "directory" });
    expect(message).toContain(backupPathFor(TARGET));
    // The old, shadowing form. Naming it keeps a future edit from drifting back.
    expect(message).not.toContain(`${TARGET}.copy-backup`);
  });
});

describe("findShadowingPlugins", () => {
  const ID = "mcp-tools-istefox";

  test("the link itself is not a shadow of itself", () => {
    const s = [{ name: ID, id: ID }];
    expect(findShadowingPlugins(s, ID, ID)).toEqual([]);
  });

  test("a backup left beside the link IS a shadow", () => {
    const s = [
      { name: ID, id: ID },
      { name: `${ID}.copy-backup`, id: ID },
    ];
    expect(findShadowingPlugins(s, ID, ID)).toEqual([`${ID}.copy-backup`]);
  });

  test("it matches on the manifest id, not on the directory name", () => {
    // The name can be anything; what collides is the id Obsidian keys on.
    const s = [
      { name: ID, id: ID },
      { name: "an-unrelated-name", id: ID },
      { name: "dataview", id: "dataview" },
    ];
    expect(findShadowingPlugins(s, ID, ID)).toEqual(["an-unrelated-name"]);
  });

  test("directories with no readable manifest are not shadows", () => {
    const s = [
      { name: ID, id: ID },
      { name: "notes-backup", id: null },
    ];
    expect(findShadowingPlugins(s, ID, ID)).toEqual([]);
  });

  test("every colliding directory is reported, not just the first", () => {
    const s = [
      { name: ID, id: ID },
      { name: `${ID}.copy-backup`, id: ID },
      { name: `${ID}.old`, id: ID },
    ];
    expect(findShadowingPlugins(s, ID, ID)).toHaveLength(2);
  });
});

describe("decideICloudTarget", () => {
  const DRIVE =
    "/Users/dev/Library/Mobile Documents/com~apple~CloudDocs/Vaults/Labs/.obsidian/plugins/mcp-tools-istefox";
  const APP_CONTAINER =
    "/Users/dev/Library/Mobile Documents/iCloud~md~obsidian/Documents/Labs/.obsidian/plugins/mcp-tools-istefox";

  test("an ordinary path is not iCloud", () => {
    expect(decideICloudTarget(TARGET, REPO, false).kind).toBe("not-icloud");
  });

  test("a path merely containing the word icloud is not iCloud", () => {
    // The marker is a real directory, not a word to grep for. `~/icloud-backup`
    // is somebody's ordinary folder.
    const d = decideICloudTarget("/Users/dev/icloud-backup/vault", REPO, false);
    expect(d.kind).toBe("not-icloud");
  });

  test("iCloud Drive is blocked without ALLOW_ICLOUD", () => {
    expect(decideICloudTarget(DRIVE, REPO, false).kind).toBe("blocked");
  });

  test("an iCloud app container counts too, not just the Drive", () => {
    // Obsidian's own iOS container is a sibling of com~apple~CloudDocs under
    // the same parent, and is synced the same way. Matching only the Drive
    // would miss it.
    expect(decideICloudTarget(APP_CONTAINER, REPO, false).kind).toBe("blocked");
  });

  test("ALLOW_ICLOUD proceeds, and still says the same two things", () => {
    const d = decideICloudTarget(DRIVE, REPO, true);
    expect(d.kind).toBe("allowed");
    if (d.kind === "not-icloud") return;
    expect(d.message).toContain("Certain:");
    expect(d.message).toContain("NOT known:");
  });

  test("the block separates what is certain from what is not", () => {
    // The whole point of the wording: the target being outside the synced
    // container is a fact, iCloud's treatment of the link itself is not, and
    // presenting them as one confident warning would be the error.
    const d = decideICloudTarget(DRIVE, REPO, false);
    if (d.kind === "not-icloud") throw new Error("expected a decision");
    expect(d.message).toContain("Certain:");
    expect(d.message).toContain("NOT known:");
    expect(d.message).toContain(REPO);
    expect(d.message).toContain("ALLOW_ICLOUD=1");
  });
});
