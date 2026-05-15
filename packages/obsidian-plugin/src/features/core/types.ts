/**
 * Result contract for a feature `setup()`. Relocated here from the
 * retired 0.3.x binary-installer module — `core` is the only live
 * consumer in the 0.4.x line.
 */
export interface SetupResult {
  success: boolean;
  error?: string;
}
