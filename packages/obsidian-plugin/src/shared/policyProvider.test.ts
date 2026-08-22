import { describe, expect, test } from "bun:test";
import { PathPolicyProvider } from "./policyProvider";
import type { PluginDataLike } from "./types";
import { compilePolicy } from "./pathPolicy";

/**
 * In-memory plugin data, with a switch to make `loadData` throw so the
 * fail-closed posture can be exercised. Mirrors settingsStore.test.ts's
 * `makePlugin`.
 */
function makePlugin(initial: Record<string, unknown> = {}) {
  let data: Record<string, unknown> = structuredClone(initial);
  let failing = false;
  let reads = 0;
  const plugin: PluginDataLike = {
    loadData: async () => {
      reads++;
      if (failing) throw new Error("data.json unreadable");
      return structuredClone(data);
    },
    saveData: async (next: unknown) => {
      data = structuredClone(next as Record<string, unknown>);
    },
  };
  return {
    plugin,
    setFailing: (v: boolean) => {
      failing = v;
    },
    setFolders: (folders: unknown) => {
      data = { mcpTools: { excludedFolders: folders } };
    },
    reads: () => reads,
  };
}

const withFolders = (folders: unknown) => ({
  mcpTools: { excludedFolders: folders },
});

describe("PathPolicyProvider — resolution", () => {
  test("compiles the configured folders", async () => {
    const { plugin } = makePlugin(withFolders(["/Therapy/", "Finances"]));
    const policy = await new PathPolicyProvider(plugin).refresh();
    expect(policy.folders).toEqual(["Therapy", "Finances"]);
    expect(policy.isExcluded("Therapy/a.md")).toBe(true);
    expect(policy.isExcluded("Public/a.md")).toBe(false);
  });

  test("an absent slice resolves to a policy that excludes nothing", async () => {
    const { plugin } = makePlugin({});
    const policy = await new PathPolicyProvider(plugin).refresh();
    expect(policy.isEmpty).toBe(true);
    expect(policy.isExcluded("Therapy/a.md")).toBe(false);
  });

  test("an absent field resolves to a policy that excludes nothing", async () => {
    const { plugin } = makePlugin({ mcpTools: { maxTextOutputKB: 50 } });
    const policy = await new PathPolicyProvider(plugin).refresh();
    expect(policy.isEmpty).toBe(true);
  });

  // A hand-edited or downgrade-round-tripped data.json can hold anything.
  test("corrupt data resolves rather than throwing", async () => {
    for (const junk of [42, "Therapy", { a: 1 }, [null, 7, {}], ["../x", ""]]) {
      const { plugin } = makePlugin(withFolders(junk));
      const policy = await new PathPolicyProvider(plugin).refresh();
      expect(policy.isEmpty).toBe(true);
    }
  });

  test("reads on every refresh — no caching of its own", async () => {
    const fixture = makePlugin(withFolders(["Therapy"]));
    const provider = new PathPolicyProvider(fixture.plugin);
    await provider.refresh();
    fixture.setFolders(["Finances"]);
    const policy = await provider.refresh();
    expect(policy.folders).toEqual(["Finances"]);
    expect(fixture.reads()).toBe(2);
  });
});

describe("PathPolicyProvider — fail-closed posture (ADR-0020 D7)", () => {
  // The single most important assertion in this file. Getting it
  // backwards means a folder is served while the settings are unreadable.
  test("before any successful read, every path is refused", () => {
    const { plugin } = makePlugin(withFolders(["Therapy"]));
    const provider = new PathPolicyProvider(plugin);
    expect(provider.vaultWide.isExcluded("Public/a.md")).toBe(true);
    expect(provider.vaultWide.isExcluded("anything.md")).toBe(true);
    expect(provider.vaultWide.isEmpty).toBe(false);
  });

  test("a failing first read leaves the deny-all posture in place", async () => {
    const fixture = makePlugin(withFolders(["Therapy"]));
    fixture.setFailing(true);
    const provider = new PathPolicyProvider(fixture.plugin);
    const policy = await provider.refresh();
    expect(policy.isExcluded("Public/a.md")).toBe(true);
    expect(provider.isDegraded).toBe(true);
  });

  test("a later failure retains the last known policy, not deny-all", async () => {
    const fixture = makePlugin(withFolders(["Therapy"]));
    const provider = new PathPolicyProvider(fixture.plugin);
    await provider.refresh();

    fixture.setFailing(true);
    const policy = await provider.refresh();
    expect(policy.folders).toEqual(["Therapy"]);
    expect(policy.isExcluded("Therapy/a.md")).toBe(true);
    expect(policy.isExcluded("Public/a.md")).toBe(false);
  });

  // The escape hatch: someone who never configured a folder must not be
  // locked out of their own vault by a transient read failure.
  test("an empty policy survives a later failure, so nothing locks out", async () => {
    const fixture = makePlugin({});
    const provider = new PathPolicyProvider(fixture.plugin);
    await provider.refresh();

    fixture.setFailing(true);
    const policy = await provider.refresh();
    expect(policy.isEmpty).toBe(true);
    expect(policy.isExcluded("Public/a.md")).toBe(false);
  });

  test("recovers on the next successful read", async () => {
    const fixture = makePlugin(withFolders(["Therapy"]));
    const provider = new PathPolicyProvider(fixture.plugin);
    fixture.setFailing(true);
    await provider.refresh();
    expect(provider.isDegraded).toBe(true);

    fixture.setFailing(false);
    const policy = await provider.refresh();
    expect(provider.isDegraded).toBe(false);
    expect(policy.folders).toEqual(["Therapy"]);
  });

  test("refresh never throws, however the read fails", async () => {
    const plugin: PluginDataLike = {
      loadData: async () => {
        throw new Error("boom");
      },
      saveData: async () => {},
    };
    const provider = new PathPolicyProvider(plugin);
    const policy = await provider.refresh();
    expect(policy.isExcluded("anything.md")).toBe(true);
  });
});

describe("PathPolicyProvider — request scope", () => {
  test("current() outside a scope is the vault-wide policy, never inert", async () => {
    const { plugin } = makePlugin(withFolders(["Therapy"]));
    const provider = new PathPolicyProvider(plugin);
    await provider.refresh();
    expect(provider.current().folders).toEqual(["Therapy"]);
    expect(provider.current().isExcluded("Therapy/a.md")).toBe(true);
  });

  test("current() inside a scope is that request's policy", async () => {
    const { plugin } = makePlugin(withFolders(["Therapy"]));
    const provider = new PathPolicyProvider(plugin);
    await provider.refresh();

    const scoped = compilePolicy(["Finances"]);
    provider.runWith(scoped, () => {
      expect(provider.current().folders).toEqual(["Finances"]);
    });
    expect(provider.current().folders).toEqual(["Therapy"]);
  });

  // The property the whole design rests on. A tool handler awaits many
  // times before it touches the vault; if the store did not survive
  // those, the facade would read the wrong policy.
  test("the policy survives awaits inside the scope", async () => {
    const { plugin } = makePlugin({});
    const provider = new PathPolicyProvider(plugin);
    const scoped = compilePolicy(["Therapy"]);

    const seen = await provider.runWith(scoped, async () => {
      await new Promise((r) => setTimeout(r, 5));
      await Promise.resolve();
      return provider.current().folders.slice();
    });
    expect(seen).toEqual(["Therapy"]);
  });

  test("concurrent scopes do not see each other's policy", async () => {
    const { plugin } = makePlugin({});
    const provider = new PathPolicyProvider(plugin);

    const run = (folder: string, delay: number) =>
      provider.runWith(compilePolicy([folder]), async () => {
        await new Promise((r) => setTimeout(r, delay));
        return provider.current().folders[0];
      });

    // Interleaved on purpose: the first to start finishes last.
    const [a, b] = await Promise.all([run("Therapy", 20), run("Finances", 1)]);
    expect(a).toBe("Therapy");
    expect(b).toBe("Finances");
  });

  test("a nested scope wins, and the outer one is restored", async () => {
    const { plugin } = makePlugin({});
    const provider = new PathPolicyProvider(plugin);

    provider.runWith(compilePolicy(["Outer"]), () => {
      expect(provider.current().folders).toEqual(["Outer"]);
      provider.runWith(compilePolicy(["Inner"]), () => {
        expect(provider.current().folders).toEqual(["Inner"]);
      });
      expect(provider.current().folders).toEqual(["Outer"]);
    });
  });

  test("a scope does not leak into the vault-wide policy", async () => {
    const { plugin } = makePlugin(withFolders(["Therapy"]));
    const provider = new PathPolicyProvider(plugin);
    await provider.refresh();
    provider.runWith(compilePolicy(["Finances"]), () => {});
    expect(provider.vaultWide.folders).toEqual(["Therapy"]);
  });
});
