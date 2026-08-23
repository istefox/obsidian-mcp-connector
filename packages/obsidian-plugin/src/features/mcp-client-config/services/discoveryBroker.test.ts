import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import {
  disableCodexDiscovery,
  enableCodexDiscovery,
  getCodexConnection,
  releaseCodexDiscoveryOwner,
  resolveCodexDiscoveryOwner,
  startCodexDiscovery,
} from "./discoveryBroker";

type StoredData = Record<string, unknown> | null;

function secretFor(id: string): string {
  return `${id}-secret-`.padEnd(40, "x");
}

function fakePlugin(initial: StoredData) {
  let data = initial;
  return {
    app: {
      vault: {
        adapter: {},
        configDir: ".obsidian",
        getName: () => "NeonHades2",
      },
    },
    manifest: { id: "mcp-tools-istefox" },
    async loadData() {
      return data;
    },
    async saveData(next: unknown) {
      data = next as StoredData;
    },
    get _data() {
      return data;
    },
  };
}

function withTokens(...ids: string[]): StoredData {
  return {
    mcpTransport: {
      tokens: ids.map((id, createdAt) => ({
        id,
        label: id,
        token: secretFor(id),
        createdAt,
      })),
    },
  };
}

let tempDir = "";
let dataPath = "";
type TestControl = {
  close(): void;
  closed: Promise<void>;
  disconnect(): void;
};
let controls: TestControl[] = [];

async function connectRegistration(): Promise<TestControl> {
  let resolveClosed!: () => void;
  let closed = false;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const disconnect = () => {
    if (closed) return;
    closed = true;
    resolveClosed();
  };
  const control = {
    close: disconnect,
    closed: closedPromise,
    disconnect,
  };
  controls.push(control);
  return control;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not met");
}

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mcp-discovery-service-"));
  dataPath = path.join(tempDir, "data.json");
  controls = [];
});

afterEach(async () => {
  controls.forEach((control) => control.close());
  await fsp.rm(tempDir, { recursive: true, force: true });
});

describe("Codex discovery ownership", () => {
  test("is opt-in and stores a stable route without storing the vault secret in the registry", async () => {
    const plugin = fakePlugin(withTokens("a", "b"));
    const runtime = await enableCodexDiscovery(plugin, "b", {
      rootDir: tempDir,
      dataPath,
      ensureBroker: async () => {},
      connectRegistration,
    });

    expect(await resolveCodexDiscoveryOwner(plugin)).toBe("b");
    const connection = await getCodexConnection(plugin);
    expect(connection?.routeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(connection?.accessToken.length).toBeGreaterThanOrEqual(32);
    const registration = await fsp.readFile(
      path.join(tempDir, "routes", `${connection!.routeId}.json`),
      "utf8",
    );
    expect(registration).not.toContain(secretFor("b"));
    expect(registration).not.toContain(connection!.accessToken);
    expect(registration).toContain('"tokenId":"b"');
    expect(registration).not.toContain("heartbeatAt");

    await runtime.stop();
  });

  test("keeps the route and broker credential stable when the selected token changes", async () => {
    const plugin = fakePlugin(withTokens("a", "b"));
    const first = await enableCodexDiscovery(plugin, "a", {
      rootDir: tempDir,
      dataPath,
      ensureBroker: async () => {},
      connectRegistration,
    });
    const before = await getCodexConnection(plugin);
    await first.stop();

    const second = await enableCodexDiscovery(plugin, "b", {
      rootDir: tempDir,
      dataPath,
      ensureBroker: async () => {},
      connectRegistration,
    });
    expect(await getCodexConnection(plugin)).toEqual(before);
    expect(await resolveCodexDiscoveryOwner(plugin)).toBe("b");
    await second.stop();
  });

  test("disable removes only the live registration and permits the same config to be reused", async () => {
    const plugin = fakePlugin(withTokens("a"));
    const runtime = await enableCodexDiscovery(plugin, "a", {
      rootDir: tempDir,
      dataPath,
      ensureBroker: async () => {},
      connectRegistration,
    });
    const connection = await getCodexConnection(plugin);
    await disableCodexDiscovery(plugin, runtime);

    expect(await resolveCodexDiscoveryOwner(plugin)).toBeNull();
    expect(await getCodexConnection(plugin)).toEqual(connection);
    expect(
      await fsp
        .stat(path.join(tempDir, "routes", `${connection!.routeId}.json`))
        .catch(() => null),
    ).toBeNull();
    expect(
      await startCodexDiscovery(plugin, {
        rootDir: tempDir,
        dataPath,
        ensureBroker: async () => {},
        connectRegistration,
      }),
    ).toBeNull();
  });

  test("revoking the owner fails closed without assigning another token", async () => {
    const plugin = fakePlugin(withTokens("a", "b"));
    const runtime = await enableCodexDiscovery(plugin, "a", {
      rootDir: tempDir,
      dataPath,
      ensureBroker: async () => {},
      connectRegistration,
    });

    expect(await releaseCodexDiscoveryOwner(plugin, "b", runtime)).toBe(false);
    expect(await resolveCodexDiscoveryOwner(plugin)).toBe("a");
    expect(await releaseCodexDiscoveryOwner(plugin, "a", runtime)).toBe(true);
    expect(await resolveCodexDiscoveryOwner(plugin)).toBeNull();
  });

  test("a closed control connection restores a broker and its route", async () => {
    const plugin = fakePlugin(withTokens("a"));
    let probes = 0;
    const runtime = await enableCodexDiscovery(plugin, "a", {
      rootDir: tempDir,
      dataPath,
      ensureBroker: async () => {
        probes += 1;
      },
      connectRegistration,
      reconnectMs: 1,
    });
    expect(probes).toBe(1);
    expect(controls).toHaveLength(1);

    controls[0].disconnect();
    await waitFor(() => probes === 2 && controls.length === 2);

    await runtime.stop();
    const stoppedAt = probes;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(probes).toBe(stoppedAt);
  });

  test("stop cancels a delayed recovery attempt", async () => {
    const plugin = fakePlugin(withTokens("a"));
    let probes = 0;
    const runtime = await enableCodexDiscovery(plugin, "a", {
      rootDir: tempDir,
      dataPath,
      ensureBroker: async () => {
        probes += 1;
        if (probes > 1) throw new Error("broker unavailable");
      },
      connectRegistration,
      reconnectMs: 60_000,
    });

    controls[0].disconnect();
    await waitFor(() => probes === 2);
    await runtime.stop();

    expect(probes).toBe(2);
  });
});

test("generated broker asset matches its source", async () => {
  const { DISCOVERY_BROKER_SOURCE } =
    await import("../assets/discoveryBrokerSource");
  const source = await fsp.readFile(
    path.join(import.meta.dir, "../../../../scripts/discoveryBroker.js"),
    "utf8",
  );
  expect(DISCOVERY_BROKER_SOURCE).toBe(source);
});
