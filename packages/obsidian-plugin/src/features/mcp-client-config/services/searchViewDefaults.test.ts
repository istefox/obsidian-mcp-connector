import { describe, expect, test } from "bun:test";
import {
  readPolicy,
  updateTokenPolicy,
} from "$/features/adaptive-tool-loading/tokenPolicyStore";
import {
  hideSearchResultsViewIfInherited,
  inheritsSearchResultsView,
} from "./searchViewDefaults";

const TOKEN_ID = "claude-code-row";

function makePlugin() {
  let data: Record<string, unknown> = {
    toolLoading: {
      profile: "adaptive",
      promoted: [],
      counters: {},
      profiles: {
        [TOKEN_ID]: { profile: "adaptive", promoted: [], allowed: null },
      },
    },
  };
  return {
    async loadData() {
      return data;
    },
    async saveData(next: unknown) {
      data = next as Record<string, unknown>;
    },
  };
}

describe("searchViewDefaults (#626)", () => {
  test("a token without an override inherits, and gets turned off once", async () => {
    const plugin = makePlugin();
    expect(await inheritsSearchResultsView(plugin, TOKEN_ID)).toBe(true);
    expect(await hideSearchResultsViewIfInherited(plugin, TOKEN_ID)).toBe(true);
    expect((await readPolicy(plugin, TOKEN_ID)).searchResultsView).toBe(false);
    // Second call: the token has an explicit choice now, nothing to write
    expect(await hideSearchResultsViewIfInherited(plugin, TOKEN_ID)).toBe(
      false,
    );
  });

  test("an explicit on is the user's choice and is kept", async () => {
    const plugin = makePlugin();
    await updateTokenPolicy(plugin, TOKEN_ID, { searchResultsView: true });
    expect(await inheritsSearchResultsView(plugin, TOKEN_ID)).toBe(false);
    expect(await hideSearchResultsViewIfInherited(plugin, TOKEN_ID)).toBe(
      false,
    );
    expect((await readPolicy(plugin, TOKEN_ID)).searchResultsView).toBe(true);
  });

  test("the rest of the policy is untouched", async () => {
    const plugin = makePlugin();
    await hideSearchResultsViewIfInherited(plugin, TOKEN_ID);
    const policy = await readPolicy(plugin, TOKEN_ID);
    expect(policy.profile).toBe("adaptive");
    expect(policy.allowed).toBeNull();
  });
});
