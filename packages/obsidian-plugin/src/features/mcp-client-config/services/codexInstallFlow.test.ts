import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import {
  readPolicy,
  type TokenPolicy,
} from "$/features/adaptive-tool-loading/tokenPolicyStore";
import {
  CodexInstallError,
  type CodexInstallResult,
  type CodexInstallTarget,
} from "./codexConfig";
import {
  CODEX_OFFERED_PROFILE,
  codexInstallNotice,
  codexProfileOffer,
  commitCodexInstall,
  prepareCodexInstall,
  type CodexInstallOutcome,
  type PreparedCodexInstall,
} from "./codexInstallFlow";
import { vaultServerId } from "./generators";

const KEY = vaultServerId("Neon Hades-2");
const ROUTE = "123e4567-e89b-42d3-a456-426614174000";
const BROKER_URL = `http://127.0.0.1:27200/v1/${ROUTE}/mcp`;
const TOKEN = "row-vault-token-0123456789abcdef0123456789";
const TOKEN_ID = "codex-row";

type ProfileName = "adaptive" | "all" | "core" | "none";

/**
 * An in-memory plugin with one token and its `toolLoading` slice, shaped
 * like `discoveryBroker.test.ts`'s `fakePlugin`. `none` leaves the token
 * without a `profiles` entry.
 */
function makePlugin(profile: ProfileName = "adaptive") {
  const policy: TokenPolicy = {
    profile: profile === "none" ? "all" : profile,
    promoted: ["search_vault"],
    allowed: ["read_note", "search_vault"],
  };
  let data: Record<string, unknown> = {
    mcpTransport: {
      tokens: [{ id: TOKEN_ID, label: "Codex", token: TOKEN, createdAt: 1 }],
    },
    toolLoading: {
      profile: policy.profile,
      promoted: policy.promoted,
      counters: {},
      profiles: profile === "none" ? {} : { [TOKEN_ID]: policy },
    },
  };
  return {
    async loadData() {
      return data;
    },
    async saveData(next: unknown) {
      data = next as Record<string, unknown>;
    },
    get _data() {
      return data;
    },
  };
}

let tempDir = "";
let userHome = "";
let projectDir = "";

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-codex-flow-"));
  userHome = path.join(tempDir, "codex-home");
  projectDir = path.join(tempDir, "project");
  await fsp.mkdir(userHome);
  await fsp.mkdir(projectDir);
});

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true });
});

const userTarget = (): CodexInstallTarget => ({
  scope: "user",
  configPath: path.join(userHome, "config.toml"),
});

const projectTarget = (): CodexInstallTarget => ({
  scope: "project",
  configPath: path.join(projectDir, ".codex", "config.toml"),
});

function request(
  over: Partial<Parameters<typeof prepareCodexInstall>[1]> = {},
): Parameters<typeof prepareCodexInstall>[1] {
  return {
    tokenId: TOKEN_ID,
    token: TOKEN,
    serverId: KEY,
    url: BROKER_URL,
    routeId: ROUTE,
    tokenForm: "literal",
    target: userTarget(),
    ...over,
  };
}

/** One line per path: files with their bytes, folders, links with their target. */
async function snapshotTree(dir: string, prefix = ""): Promise<string[]> {
  const lines: string[] = [];
  for (const entry of await fsp.readdir(dir)) {
    const full = path.join(dir, entry);
    const name = `${prefix}${entry}`;
    const stat = await fsp.lstat(full);
    if (stat.isSymbolicLink())
      lines.push(`${name} -> ${await fsp.readlink(full)}`);
    else if (stat.isDirectory()) {
      lines.push(`${name}/`);
      lines.push(...(await snapshotTree(full, `${name}/`)));
    } else lines.push(`${name}: ${await fsp.readFile(full, "utf8")}`);
  }
  return lines.sort();
}

describe("codexProfileOffer (R-09)", () => {
  test("an adaptive token is offered All tools", async () => {
    expect(CODEX_OFFERED_PROFILE).toBe("all");
    expect(await codexProfileOffer(makePlugin("adaptive"), TOKEN_ID)).toEqual({
      tokenId: TOKEN_ID,
      from: "adaptive",
      to: "all",
    });
  });

  test("all and core tokens get no offer", async () => {
    expect(await codexProfileOffer(makePlugin("all"), TOKEN_ID)).toBeNull();
    expect(await codexProfileOffer(makePlugin("core"), TOKEN_ID)).toBeNull();
  });

  test("a token with no policy entry resolves to adaptive and gets the offer", async () => {
    expect(await codexProfileOffer(makePlugin("none"), TOKEN_ID)).toEqual({
      tokenId: TOKEN_ID,
      from: "adaptive",
      to: "all",
    });
  });
});

describe("prepareCodexInstall", () => {
  test("a project target with a literal token previews the env form, without the token (R-08)", async () => {
    const prepared = await prepareCodexInstall(
      makePlugin(),
      request({ target: projectTarget(), tokenForm: "literal" }),
    );
    expect(prepared.preview.tokenForm).toBe("env");
    expect(prepared.preview.scope).toBe("project");
    expect(prepared.preview.snippet).not.toContain(TOKEN);
    expect(prepared.preview.snippet).toContain("OBSIDIAN_MCP_TOKEN");
    expect(JSON.stringify(prepared.input)).not.toContain(TOKEN);
  });

  test("preparing writes nothing, for a user and a project target (R-12)", async () => {
    await fsp.writeFile(
      path.join(userHome, "config.toml"),
      'model = "gpt-5"\n',
      "utf8",
    );
    const before = await snapshotTree(tempDir);
    await prepareCodexInstall(makePlugin(), request());
    await prepareCodexInstall(
      makePlugin(),
      request({ target: projectTarget(), tokenForm: "literal" }),
    );
    expect(await snapshotTree(tempDir)).toEqual(before);
  });

  test("a user target keeps the literal form and carries the request through", async () => {
    const target = userTarget();
    const prepared = await prepareCodexInstall(
      makePlugin(),
      request({ target }),
    );
    expect(prepared.tokenId).toBe(TOKEN_ID);
    expect(prepared.target).toEqual(target);
    expect(prepared.preview.tokenForm).toBe("literal");
    expect(prepared.preview.serverId).toBe(KEY);
    expect(prepared.preview.url).toBe(BROKER_URL);
    expect(prepared.input.routeId).toBe(ROUTE);
    expect(prepared.preview.action).toBe("add");
  });

  test("the prepared install carries the profile offer of its token (R-09)", async () => {
    expect(
      (await prepareCodexInstall(makePlugin("adaptive"), request()))
        .profileOffer,
    ).toEqual({ tokenId: TOKEN_ID, from: "adaptive", to: "all" });
    expect(
      (await prepareCodexInstall(makePlugin("core"), request())).profileOffer,
    ).toBeNull();
  });
});

describe("commitCodexInstall", () => {
  async function prepared(
    plugin = makePlugin(),
    over: Partial<Parameters<typeof prepareCodexInstall>[1]> = {},
  ): Promise<PreparedCodexInstall> {
    return prepareCodexInstall(plugin, request(over));
  }

  test("a declined confirmation is cancelled: no file, profile unchanged (R-12, R-09)", async () => {
    const plugin = makePlugin();
    const outcome = await commitCodexInstall(plugin, await prepared(plugin), {
      confirmed: false,
      switchProfile: true,
    });
    expect(outcome).toEqual({ status: "cancelled" });
    expect(await fsp.readdir(userHome)).toEqual([]);
    expect((await readPolicy(plugin, TOKEN_ID)).profile).toBe("adaptive");
  });

  test("confirming without the box installs and leaves the profile (R-09)", async () => {
    const plugin = makePlugin();
    const outcome = await commitCodexInstall(plugin, await prepared(plugin), {
      confirmed: true,
      switchProfile: false,
    });
    expect(outcome.status).toBe("installed");
    if (outcome.status !== "installed") return;
    expect(outcome.result.action).toBe("add");
    expect(outcome.profileSwitched).toBe(false);
    expect(
      await fsp.readFile(path.join(userHome, "config.toml"), "utf8"),
    ).toContain(`[mcp_servers.${KEY}]`);
    expect((await readPolicy(plugin, TOKEN_ID)).profile).toBe("adaptive");
  });

  test("confirming with the box installs and sets All, keeping promoted and allowed (R-09)", async () => {
    const plugin = makePlugin();
    const outcome = await commitCodexInstall(plugin, await prepared(plugin), {
      confirmed: true,
      switchProfile: true,
    });
    expect(outcome.status).toBe("installed");
    if (outcome.status !== "installed") return;
    expect(outcome.profileSwitched).toBe(true);
    expect(await readPolicy(plugin, TOKEN_ID)).toEqual({
      profile: "all",
      promoted: ["search_vault"],
      allowed: ["read_note", "search_vault"],
    });
  });

  test("an entry that is already installed still applies a confirmed switch (ADR-0028 D8)", async () => {
    const plugin = makePlugin();
    await commitCodexInstall(plugin, await prepared(plugin), {
      confirmed: true,
      switchProfile: false,
    });
    const again = await prepared(plugin);
    expect(again.preview.action).toBe("unchanged");
    expect(again.profileOffer).not.toBeNull();
    const outcome = await commitCodexInstall(plugin, again, {
      confirmed: true,
      switchProfile: true,
    });
    expect(outcome.status).toBe("installed");
    if (outcome.status !== "installed") return;
    expect(outcome.result.action).toBe("unchanged");
    expect(outcome.profileSwitched).toBe(true);
    expect((await readPolicy(plugin, TOKEN_ID)).profile).toBe("all");
  });

  test("a file changed between prepare and commit rejects and leaves the profile (R-09)", async () => {
    const plugin = makePlugin();
    const ready = await prepared(plugin);
    const changed = 'model = "changed-after-preview"\n';
    await fsp.writeFile(path.join(userHome, "config.toml"), changed, "utf8");

    await expect(
      commitCodexInstall(plugin, ready, {
        confirmed: true,
        switchProfile: true,
      }),
    ).rejects.toBeInstanceOf(CodexInstallError);
    expect(await fsp.readFile(path.join(userHome, "config.toml"), "utf8")).toBe(
      changed,
    );
    expect((await readPolicy(plugin, TOKEN_ID)).profile).toBe("adaptive");
  });

  test("switchProfile with no offer writes no policy", async () => {
    const plugin = makePlugin("core");
    const ready = await prepared(plugin);
    expect(ready.profileOffer).toBeNull();
    const before = JSON.stringify(plugin._data);
    const outcome = await commitCodexInstall(plugin, ready, {
      confirmed: true,
      switchProfile: true,
    });
    expect(outcome.status).toBe("installed");
    if (outcome.status === "installed")
      expect(outcome.profileSwitched).toBe(false);
    expect(JSON.stringify(plugin._data)).toBe(before);
    expect((await readPolicy(plugin, TOKEN_ID)).profile).toBe("core");
  });

  test("a project install writes the env form only", async () => {
    const plugin = makePlugin();
    const outcome = await commitCodexInstall(
      plugin,
      await prepared(plugin, { target: projectTarget() }),
      { confirmed: true, switchProfile: false },
    );
    expect(outcome.status).toBe("installed");
    const written = await fsp.readFile(projectTarget().configPath, "utf8");
    expect(written).toContain('bearer_token_env_var = "OBSIDIAN_MCP_TOKEN"');
    expect(written).not.toContain(TOKEN);
  });
});

describe("codexInstallNotice", () => {
  function installed(
    over: Partial<CodexInstallResult> = {},
  ): Extract<CodexInstallOutcome, { status: "installed" }> {
    return {
      status: "installed",
      profileSwitched: false,
      result: {
        scope: "user",
        configPath: "/home/me/.codex/config.toml",
        serverId: KEY,
        url: BROKER_URL,
        action: "add",
        tokenForm: "literal",
        createsFile: true,
        createsDirectory: false,
        revision: "revision",
        snippet: `[mcp_servers.${KEY}]\nhttp_headers = { Authorization = "Bearer ${TOKEN}" }`,
        ...over,
      },
    };
  }

  test("a project install names the config path and the backup, and says Codex needs a trusted project (R-12)", () => {
    const notice = codexInstallNotice(
      installed({
        scope: "project",
        tokenForm: "env",
        configPath: "/home/me/project/.codex/config.toml",
        backupPath: "/home/me/project/.codex/config.toml.backup-1-abc",
        action: "replace",
      }),
    );
    expect(notice).toContain("/home/me/project/.codex/config.toml");
    expect(notice).toContain(
      "/home/me/project/.codex/config.toml.backup-1-abc",
    );
    expect(notice).toMatch(/trusted project/);
  });

  test("a project install without a backup does not invent one", () => {
    const notice = codexInstallNotice(
      installed({
        scope: "project",
        tokenForm: "env",
        configPath: "/home/me/project/.codex/config.toml",
      }),
    );
    expect(notice).toContain("/home/me/project/.codex/config.toml");
    expect(notice).not.toMatch(/backup/i);
  });

  test("the env form names OBSIDIAN_MCP_TOKEN", () => {
    expect(codexInstallNotice(installed({ tokenForm: "env" }))).toContain(
      "OBSIDIAN_MCP_TOKEN",
    );
  });

  test("a user config install does not mention trust, and no notice carries the token", () => {
    const literal = codexInstallNotice(installed());
    expect(literal).toContain("/home/me/.codex/config.toml");
    expect(literal).not.toMatch(/trust/i);
    expect(literal).not.toContain(TOKEN);
    const env = codexInstallNotice(installed({ tokenForm: "env" }));
    expect(env).not.toMatch(/trust/i);
  });
});
