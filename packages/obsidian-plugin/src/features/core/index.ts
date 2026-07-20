import { mount, unmount } from "svelte";
import type { SetupResult } from "./types";
import SettingsTab from "./components/SettingsTab.svelte";

import { App, PluginSettingTab } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type McpToolsPlugin from "../../main";

export class McpToolsSettingTab extends PluginSettingTab {
  plugin: McpToolsPlugin;
  component?: {
    $set?: unknown;
    $on?: unknown;
  };

  constructor(app: App, plugin: McpToolsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private mountInto(containerEl: HTMLElement): void {
    containerEl.empty();
    this.component = mount(SettingsTab, {
      target: containerEl,
      props: { plugin: this.plugin },
    });
  }

  private unmountComponent(): void {
    if (this.component) {
      void unmount(this.component);
      this.component = undefined;
    }
  }

  /**
   * Declarative settings API (Obsidian 1.13.0+): a single render-type
   * definition mounts the existing Svelte UI into the row, so the tab
   * registers with Settings search instead of vanishing from it. When this
   * returns a non-empty array, Obsidian never calls display() — it renders
   * declaratively from these definitions instead — so display() below stays
   * untouched as the pre-1.13.0 fallback (minAppVersion here is 1.7.2).
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: this.plugin.manifest.name,
        render: (setting) => {
          this.mountInto(setting.settingEl);
          return () => this.unmountComponent();
        },
      },
    ];
  }

  display(): void {
    this.mountInto(this.containerEl);
  }

  hide(): void {
    this.unmountComponent();
  }
}

export function setup(plugin: McpToolsPlugin): Promise<SetupResult> {
  try {
    plugin.addSettingTab(new McpToolsSettingTab(plugin.app, plugin));
    return Promise.resolve({ success: true });
  } catch (error) {
    return Promise.resolve({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
