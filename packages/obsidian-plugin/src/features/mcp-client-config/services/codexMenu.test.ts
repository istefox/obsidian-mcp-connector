import { describe, expect, test } from "bun:test";
import type { CodexHomeLocation, CodexProjectLocation } from "./codexConfig";
import { codexMenuItems } from "./codexMenu";

const URL =
  "http://127.0.0.1:27200/v1/123e4567-e89b-42d3-a456-426614174000/mcp";

const home: CodexHomeLocation = {
  located: true,
  codexHome: "/home/me/.codex",
  configPath: "/home/me/.codex/config.toml",
  source: "default",
  exists: true,
};

const project: CodexProjectLocation = {
  located: true,
  projectPath: "/home/me/project",
  configPath: "/home/me/project/.codex/config.toml",
  codexDirExists: false,
};

const ready = { endpointUrl: URL, busy: false, home, project };

describe("Codex menu items", () => {
  test("offers four actions in a fixed order (R-01)", () => {
    expect(codexMenuItems(ready).map((item) => item.action)).toEqual([
      "copy-snippet",
      "copy-command",
      "install-user",
      "install-project",
    ]);
  });

  test("every item has a title", () => {
    for (const item of codexMenuItems(ready)) {
      expect(item.title.length).toBeGreaterThan(0);
    }
  });

  test("with everything located and idle, none is disabled", () => {
    expect(codexMenuItems(ready).map((item) => item.disabled)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  test("an unavailable endpoint disables all four (R-01)", () => {
    const items = codexMenuItems({ ...ready, endpointUrl: "" });
    expect(items).toHaveLength(4);
    expect(items.every((item) => item.disabled)).toBe(true);
  });

  test("a running action disables all four (R-01)", () => {
    const items = codexMenuItems({ ...ready, busy: true });
    expect(items).toHaveLength(4);
    expect(items.every((item) => item.disabled)).toBe(true);
  });

  test("a home that is not located disables only the user install, with its reason (R-08)", () => {
    const reason = "CODEX_HOME must be an absolute path to an existing folder.";
    const items = codexMenuItems({
      ...ready,
      home: { located: false, reason },
    });
    expect(items.map((item) => item.disabled)).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(items[2].action).toBe("install-user");
    expect(items[2].reason).toBe(reason);
  });

  test("a project that is not located disables only the project install, with its reason (R-08)", () => {
    const reason = "The project folder does not exist.";
    const items = codexMenuItems({
      ...ready,
      project: { located: false, reason },
    });
    expect(items.map((item) => item.disabled)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(items[3].action).toBe("install-project");
    expect(items[3].reason).toBe(reason);
  });

  test("both locations missing disables both installs and leaves the copy actions", () => {
    const items = codexMenuItems({
      ...ready,
      home: { located: false, reason: "no home" },
      project: { located: false, reason: "no project" },
    });
    expect(items.map((item) => item.disabled)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });
});
