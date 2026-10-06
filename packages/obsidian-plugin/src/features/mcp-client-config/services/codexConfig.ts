export type CodexConnection = {
  /** The entry key, `vaultServerId` like every other client config. */
  serverId: string;
  /** The vault token of the row the entry is made for. */
  accessToken: string;
  /** From resolveClientEndpoint, like every other client config. */
  url: string;
  /**
   * Name of an environment variable Codex reads the bearer token from. When
   * set, the snippet carries `bearer_token_env_var` instead of a static
   * `http_headers` block, so the token is not written to `config.toml`. Codex
   * must then be started with that variable set.
   */
  bearerTokenEnvVar?: string;
  /** Emitted as `startup_timeout_sec`. */
  startupTimeoutSec?: number;
};

export function codexConfigSnippet(input: CodexConnection): string {
  const { serverId, url } = input;
  if (!/^[a-zA-Z0-9_-]+$/.test(serverId))
    throw new Error("Invalid connection entry identity");
  const envVar = input.bearerTokenEnvVar?.trim();
  if (envVar !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar))
    throw new Error("Invalid environment variable name");
  const timeout = input.startupTimeoutSec;
  if (timeout !== undefined && !(Number.isInteger(timeout) && timeout > 0))
    throw new Error("startupTimeoutSec must be a positive integer");
  return [
    `[mcp_servers.${serverId}]`,
    `url = ${tomlString(url)}`,
    envVar
      ? `bearer_token_env_var = ${tomlString(envVar)}`
      : `http_headers = { Authorization = ${tomlString(`Bearer ${input.accessToken}`)} }`,
    "enabled = true",
    "required = false",
    ...(timeout !== undefined ? [`startup_timeout_sec = ${timeout}`] : []),
  ].join("\n");
}

function tomlString(value: string): string {
  return JSON.stringify(value)
    .replace(/\\u2028/g, "\\u2028")
    .replace(/\\u2029/g, "\\u2029");
}
