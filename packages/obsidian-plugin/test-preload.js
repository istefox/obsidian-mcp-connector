// Test-only bootstrap, plain JS and outside src/ on purpose: Bun's test
// runner has no `window` global, and production code calls
// window.setTimeout/clearTimeout (Obsidian popout-window compat), so a
// `window` alias for the global object must exist before any TS module
// loads. Creating that alias requires touching the global object — the
// exact thing the community-plugin source rules (rightly) restrict for
// SHIPPED code. Keeping this one assignment in test infrastructure
// outside the TypeScript tree keeps those rules meaningful for src/.
globalThis.window = globalThis;
