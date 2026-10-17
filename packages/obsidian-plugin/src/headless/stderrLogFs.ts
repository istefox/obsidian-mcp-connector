/**
 * A `LogFs` that sends the logger's lines to stderr. The headless server
 * has no plugin directory to hold a log file, and over stdio stdout
 * belongs to the protocol, so stderr is the one place a log can go.
 * There is nothing to rotate or read back.
 */

import { format } from "node:util";
import type { LogFs } from "$/shared/log/logSink";

export const stderrLogFs: LogFs = {
  async appendFile(_path, data) {
    process.stderr.write(data);
  },
  async stat() {
    return { size: 0 };
  },
  async rename() {},
  async unlink() {},
  async readFile() {
    return "";
  },
  join: (...parts) => parts.join("/"),
};

/**
 * Send the console methods that print to stdout to stderr instead. Over
 * stdio a dependency that prints would corrupt the protocol: json-logic's
 * `log` operator, reachable from `search_vault`, calls `console.log`.
 */
export function routeConsoleToStderr(target: Console = console): void {
  for (const method of ["log", "info", "debug", "warn"] as const) {
    target[method] = (...args: unknown[]) => {
      process.stderr.write(`${format(...args)}\n`);
    };
  }
}
