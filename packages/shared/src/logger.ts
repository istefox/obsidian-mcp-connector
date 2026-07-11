import { type } from "arktype";
import { existsSync as _existsSync, mkdirSync as _mkdirSync } from "fs";
import { appendFile as _appendFile } from "fs/promises";
import { homedir as _homedir, platform as _platform } from "os";
import { dirname as _dirname, resolve as _resolve } from "path";

// Node builtins behind locally-declared signatures: the
// community-plugin scanner type-checks without @types/node, so the
// bare imports resolve as `any` there and every call trips the
// no-unsafe-* rules. The assertions are exact subsets of the real
// @types/node signatures this module uses.
const existsSync = _existsSync as (path: string) => boolean;
const mkdirSync = _mkdirSync as (
  path: string,
  options?: { recursive?: boolean },
) => void;
const appendFile = _appendFile as (path: string, data: string) => Promise<void>;
const homedir = _homedir as () => string;
const platform = _platform as () => string;
const dirname = _dirname as (path: string) => string;
const resolve = _resolve as (...paths: string[]) => string;

/**
 * Determines the appropriate log directory path based on the current operating system.
 * @param appName - The name of the application to use in the log directory path.
 * @returns The full path to the log directory for the current operating system.
 * @throws {Error} If the current operating system is not supported.
 */
export function getLogFilePath(appName: string, fileName: string) {
  switch (platform()) {
    case "darwin": // macOS
      return resolve(homedir(), "Library", "Logs", appName, fileName);

    case "win32": // Windows
      return resolve(homedir(), "AppData", "Local", "Logs", appName, fileName);

    case "linux": // Linux
      return resolve(homedir(), ".local", "share", "logs", appName, fileName);

    default:
      throw new Error("Unsupported operating system");
  }
}

const ensureDirSync = (dirPath: string) => {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
};

const logLevels = ["DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const;
export const logLevelSchema = type.enumerated(...logLevels);
export type LogLevel = typeof logLevelSchema.infer;

const formatMessage = (
  level: LogLevel,
  message: unknown,
  meta: Record<string, unknown>,
) => {
  const timestamp = new Date().toISOString();
  const metaStr = Object.keys(meta).length
    ? `\n${JSON.stringify(meta, null, 2)}`
    : "";
  return `${timestamp} [${level.padEnd(5)}] ${JSON.stringify(
    message,
  )}${metaStr}\n`;
};

const loggerConfigSchema = type({
  appName: "string",
  filename: "string",
  level: logLevelSchema,
});
export const loggerConfigMorph = loggerConfigSchema.pipe((config) => {
  const filename = getLogFilePath(config.appName, config.filename);
  const levels = logLevels.slice(logLevels.indexOf(config.level));
  return { ...config, levels, filename };
});

export type InputLoggerConfig = typeof loggerConfigSchema.infer;
export type FullLoggerConfig = typeof loggerConfigMorph.infer;

/**
 * Creates a logger instance with configurable options for logging to a file.
 * The logger provides methods for logging messages at different log levels (DEBUG, INFO, WARN, ERROR, FATAL).
 * @param config - An object with configuration options for the logger.
 * @param config.filepath - The file path to use for logging to a file.
 * @param config.level - The minimum log level to log messages.
 * @returns An object with logging methods (debug, info, warn, error, fatal).
 */
export function createLogger(inputConfig: InputLoggerConfig) {
  let config: FullLoggerConfig = loggerConfigMorph.assert(inputConfig);
  let logMeta: Record<string, unknown> = {};

  const queue: Promise<void>[] = [];
  // Ensure the log directory once per (possibly reconfigured) target
  // path, not on every log call — the sync exists/mkdir pair on the
  // per-call path was a blocking fs stat per log line. config.filename
  // is already the morphed absolute path.
  let ensuredDir: string | null = null;
  const log = (level: LogLevel, message: unknown, meta?: typeof logMeta) => {
    if (!config.levels.includes(level)) return;
    const dir = dirname(config.filename);
    if (ensuredDir !== dir) {
      ensureDirSync(dir);
      ensuredDir = dir;
    }
    queue.push(
      appendFile(
        config.filename,
        formatMessage(level, message, { ...logMeta, ...(meta ?? {}) }),
      ),
    );
  };

  const debug = (message: unknown, meta?: typeof logMeta) =>
    log("DEBUG", message, meta);
  const info = (message: unknown, meta?: typeof logMeta) =>
    log("INFO", message, meta);
  const warn = (message: unknown, meta?: typeof logMeta) =>
    log("WARN", message, meta);
  const error = (message: unknown, meta?: typeof logMeta) =>
    log("ERROR", message, meta);
  const fatal = (message: unknown, meta?: typeof logMeta) =>
    log("FATAL", message, meta);

  const logger = {
    debug,
    info,
    warn,
    error,
    fatal,
    flush() {
      return Promise.all(queue);
    },
    get config(): FullLoggerConfig {
      return { ...config };
    },
    /**
     * Updates the configuration of the logger instance.
     * @param newConfig - A partial configuration object to merge with the existing configuration.
     * This method updates the log levels based on the new configuration level, and then merges the new configuration with the existing configuration.
     */
    set config(newConfig: Partial<InputLoggerConfig>) {
      config = loggerConfigMorph.assert({ ...config, ...newConfig });
      logger.debug("Updated logger configuration", { config });
    },
    set meta(newMeta: Record<string, unknown>) {
      logMeta = newMeta;
    },
  };

  return logger;
}
