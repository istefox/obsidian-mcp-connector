import {
  createLogger,
  loggerConfigMorph,
  type InputLoggerConfig,
} from "shared";

const isProd = process.env.NODE_ENV === "production";

export const LOGGER_CONFIG: InputLoggerConfig = {
  appName: "Claude",
  filename: "obsidian-plugin-mcp-tools.log",
  level: "DEBUG",
};

// Validates LOGGER_CONFIG at module load; the morph's output is not used.
loggerConfigMorph.assert(LOGGER_CONFIG);

/**
 * In production, we use the console. During development, the logger writes logs to a file in the same folder as the server log file.
 */
export const logger = isProd ? console : createLogger(LOGGER_CONFIG);
