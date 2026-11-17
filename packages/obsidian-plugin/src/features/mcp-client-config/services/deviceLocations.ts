/**
 * The per-device record of where each broker route lives on this computer
 * (ADR-0035). It lives in `window.localStorage`, which Obsidian keeps per
 * device and shares across vaults; the route ID keys each vault's entry.
 * A synced `data.json` never carries it.
 */

/** Route ID to the canonical `data.json` path this device bound it to. */
export type DeviceLocationStore = {
  get(routeId: string): string | null;
  set(routeId: string, dataPath: string): void;
};

export const DEVICE_LOCATIONS_KEY = "obsidian-mcp-connector:broker-locations";

export type PathStyle = "windows" | "posix" | "other";

export type LocationVerdict = "bind" | "same" | "changed";

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function storage(): Storage {
  const found = window.localStorage;
  if (typeof found?.getItem !== "function") {
    throw new Error("window.localStorage is not available");
  }
  if (typeof found.setItem !== "function") {
    throw new Error("window.localStorage cannot be written");
  }
  return found;
}

/** The stored map. Throws when the storage is unusable or the value is bad. */
function readMap(found: Storage): Record<string, unknown> {
  const raw = found.getItem(DEVICE_LOCATIONS_KEY);
  if (raw === null) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!isMap(parsed)) throw new Error("The device location record is invalid");
  return parsed;
}

/** The device record over `window.localStorage`, read lazily on every call. */
export function windowLocationStore(): DeviceLocationStore {
  return {
    get(routeId) {
      const value = readMap(storage())[routeId];
      return typeof value === "string" ? value : null;
    },
    set(routeId, dataPath) {
      const found = storage();
      let map: Record<string, unknown>;
      try {
        map = readMap(found);
      } catch {
        // A corrupt value must not make every later write fail
        map = {};
      }
      found.setItem(
        DEVICE_LOCATIONS_KEY,
        JSON.stringify({ ...map, [routeId]: dataPath }),
      );
    },
  };
}

/** The style of a path, read from its text only. */
export function pathStyle(file: string): PathStyle {
  if (/^[A-Za-z]:[\\/]/.test(file) || file.startsWith("\\\\")) return "windows";
  if (file.startsWith("/")) return "posix";
  return "other";
}

/**
 * What a start or a check makes of this device's record and the legacy
 * synced value. An entry decides alone. Without one, the legacy value
 * prompts only when it is this vault's own file in an older form (bind),
 * or when both styles are known and differ (bind, ignored), and otherwise
 * when it differs (changed).
 */
export function classifyLocation(input: {
  local: string | null;
  legacy: string | undefined;
  current: string;
  legacyIsOwnFile: boolean;
}): LocationVerdict {
  const { local, legacy, current, legacyIsOwnFile } = input;
  if (local !== null) return local === current ? "same" : "changed";
  if (legacy === undefined || legacy === current || legacyIsOwnFile) {
    return "bind";
  }
  const legacyStyle = pathStyle(legacy);
  const currentStyle = pathStyle(current);
  const crossStyle =
    legacyStyle !== "other" &&
    currentStyle !== "other" &&
    legacyStyle !== currentStyle;
  return crossStyle ? "bind" : "changed";
}
