<script lang="ts">
  import { FeatureSettings as CommandPermissionsSettings } from "src/features/command-permissions";
  import { FeatureSettings as SemanticSearchSettings } from "src/features/semantic-search";
  import { AccessControlSection } from "src/features/mcp-transport";
  import { ClientConfigSection } from "src/features/mcp-client-config";
  import type McpServerPlugin from "src/main";

  // 0.4.0 no longer ships an external `mcp-server` binary — the MCP
  // server runs in-process. The binary-installer settings section
  // (Install server, Local REST API required, Installation location,
  // Server install folder, …) was a 0.3.x install-flow surface and
  // is hidden from the 0.4.0 settings tab. The retired installer module
  // was removed in chore(0.4) as part of T14.

  // The `tool-toggle` UI is also hidden in 0.4.0. On 0.3.x the toggle
  // wrote `OBSIDIAN_DISABLED_TOOLS` into the binary's env, and the
  // binary read it at startup to filter the registered tools. The
  // 0.4.0 in-process registry has no equivalent gating path yet, so
  // showing the UI would be misleading — the user could "disable" a
  // tool that would still be reachable on the next call. The
  // persisted `toolToggle.disabled` slice in `data.json` is left
  // intact so future installs can read it back without losing data;
  // a 0.4.x follow-up will wire the registry gating and re-mount the
  // UI. Until then: hidden, not deleted.

  export let plugin: McpServerPlugin;
</script>

<div class="settings-container">
  <AccessControlSection {plugin} />
  <ClientConfigSection {plugin} />
  <CommandPermissionsSettings {plugin} />
  <SemanticSearchSettings {plugin} />
</div>
