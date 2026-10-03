/**
 * Helpers shared by `set_note_property` and `update_note_properties`: the
 * rule for a plain top-level YAML key, and the unwrapping of a list that an
 * LLM client sent as JSON text.
 */

export type PropertyValue = string | number | boolean | string[] | number[];

/**
 * A colon, any newline, or a leading `#` cannot appear in a plain top-level
 * YAML key, and a key cannot be empty.
 */
export function isInvalidKey(key: string): boolean {
  return (
    key.length === 0 || /[:\n\r]/.test(key) || key.trimStart().startsWith("#")
  );
}

/**
 * LLM clients sometimes send an array as its JSON text (`'["a","b"]'`)
 * instead of a native array. Unwrap a homogeneous string or number array so
 * `processFrontMatter` writes a YAML list rather than a quoted string.
 */
export function coerceJsonEncodedArray(value: PropertyValue): PropertyValue {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return value;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.length === 0) return value;
    if (parsed.every((item): item is string => typeof item === "string")) {
      return parsed;
    }
    if (parsed.every((item): item is number => typeof item === "number")) {
      return parsed;
    }
  } catch {
    // not valid JSON: use the string as-is
  }
  return value;
}
