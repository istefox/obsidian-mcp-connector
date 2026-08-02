import type { ToolProfile } from "./tokenPolicyStore";

declare module "obsidian" {
  interface McpToolsPluginSettings {
    toolLoading?: {
      /** Legacy mirror of `profiles[tokens[0].id].profile` (ADR-0014 §7). */
      profile: ToolProfile;
      /** Global: call frequency is a property of the vault, not of a client. */
      counters: Record<string, number>;
      /** Legacy mirror of `profiles[tokens[0].id].promoted`. */
      promoted: string[];
      /** Per-token policy, keyed by `mcpTransport.tokens[].id`. */
      profiles?: Record<
        string,
        {
          profile: ToolProfile;
          promoted: string[];
          allowed: string[] | null;
        }
      >;
    };
  }
}

/**
 * Minimal structural view of the tool registry used by the
 * adaptive-loading meta-tools. Defined here (not as the concrete
 * ToolRegistryClass type) so handlers stay testable with plain mocks.
 * Extend locally where a consumer needs more (e.g. setAdaptiveDisabled,
 * setUserDisabled).
 */
export type RegistryLike = {
  listAll: () => {
    name: string;
    description: string;
    enabled: boolean;
    userDisabled: boolean;
  }[];
};
