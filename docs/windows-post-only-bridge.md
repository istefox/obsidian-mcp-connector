# Windows workaround: POST-only bridge

On some Windows setups, Claude Desktop fails to connect to the plugin through `mcp-remote`. The connection starts, the `initialize` request is sent, and then nothing happens for 60 seconds until it times out with "Could not attach to MCP server". The plugin and its HTTP server are fine: Claude Code connects over direct HTTP without trouble, and the same `mcp-remote` hang reproduces against unrelated MCP servers on the same machine. The fault is in the `mcp-remote` bridge on Windows, not in the plugin.

`scripts/obsidian_mcp_bridge.py` replaces `mcp-remote` with a small bridge that speaks to the plugin over POST only. It never opens the GET stream that triggers the hang. It uses the Python standard library, so there is nothing to install beyond Python itself.

## Requirements

- Python 3.8 or newer on PATH (`python --version`).
- The plugin running in Obsidian, with its bearer token and port from the plugin settings.

## Setup

1. Save `obsidian_mcp_bridge.py` somewhere stable, for example `C:\Users\you\obsidian_mcp_bridge.py`.
2. Open the plugin settings and copy the bearer token and the port (the URL is `http://127.0.0.1:<port>/mcp`).
3. Edit `claude_desktop_config.json` to launch the bridge instead of `mcp-remote`:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "python",
      "args": ["C:\\Users\\you\\obsidian_mcp_bridge.py", "http://127.0.0.1:27200/mcp"],
      "env": { "OBSIDIAN_BEARER_TOKEN": "paste-your-token-here" }
    }
  }
}
```

4. Fully quit Claude Desktop and reopen it. It only reads the config at launch.

## Checking it works

Ask Claude to list your vault files. If the tools respond, the bridge is working. The bridge writes a short line to Claude Desktop's MCP log on start (`[obsidian-bridge] started`), and reports the negotiated protocol after the first `initialize`.

## Limits

The bridge carries requests and responses, which covers every tool call and prompt. It does not carry server-initiated notifications, because the plugin's stateless server never sends any. This is the same trade-off the plugin already makes for `mcp-remote` (the `tools/list_changed` notification is best-effort).

## When you can drop it

Once `mcp-remote` ships a fix for the Windows hang, the standard setup in the README works again and you can switch `claude_desktop_config.json` back to `mcp-remote`.
