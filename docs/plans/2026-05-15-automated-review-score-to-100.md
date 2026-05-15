# Automated-Review Score → 100 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate every warning/recommendation category the Obsidian Community automated reviewer surfaced, on the `feat/http-embedded` (0.4.x) line, and make the whole monorepo lint/type/build clean, so the 0.4.x line is positioned to score at or near 100 when it becomes the released/submitted version.

**Architecture:** The automated reviewer scans the **entire repository source** (its 0.3.12 report cited `packages/mcp-server/*`, `packages/test-site/eslint.config.js`, and `packages/obsidian-plugin/*`). The dominant warning clusters come from two **legacy 0.3.x subsystems that 0.4.x does not use at runtime** (`packages/mcp-server` — the standalone stdio binary; `packages/obsidian-plugin/src/features/mcp-server-install` — the binary installer). Retiring them removes the bulk of warnings; the remainder is small lint + CI/release hygiene. Every phase is an independent branch + PR into `feat/http-embedded` (never `main`).

**Tech Stack:** Bun workspaces, TypeScript strict, `bun:test`, GitHub Actions (`release.yml`), Obsidian plugin (Svelte 5).

---

## Honest scope & limits (read before executing)

1. **The only automated-reviewer data we have is for `main` / 0.3.12, commit `ba4110e`, score 79.** There is no scorecard for `feat/http-embedded` yet (0.4.x has never been submitted). This plan removes the **known** warning *categories* (same code exists on `feat/http-embedded`) and makes the repo objectively clean; it cannot guarantee a numeric "100" because the scorer's full weighting rubric is not public and only `Warning`/`Recommendation` lines were shown (no `Failure`).
2. **Strategic gate (NOT actionable by this plan):** the directory score is computed on the **submitted/released version**, which is currently `main` 0.3.12. The score only moves to ~100 when **0.4.x is released/submitted**. That requires Stefano's explicit decision to bump/release 0.4.x off protected `main` (hard rule — see `CLAUDE.md` § Branch protection policy / `feedback_main_branch_protection`). This plan makes 0.4.x review-clean so it is *ready* when that decision is made; it must not perform the bump.
3. **Risk accepted by Phases 1–2:** removing `packages/mcp-server` and `features/mcp-server-install` from `feat/http-embedded` deletes the in-repo 0.3.x rollback safety net **on this branch only**. `main` (0.3.x) keeps both; full history remains in git. This is the intended end-state of CLAUDE.md's "T14 retires it for good".

---

## File Structure (what changes, by phase)

- **Phase 1** — delete `packages/mcp-server/` (whole workspace package). No source edits in `obsidian-plugin` (verified: zero runtime imports — only doc-comment "ported from" mentions).
- **Phase 2** — delete `packages/obsidian-plugin/src/features/mcp-server-install/`; relocate two small pieces it still owns:
  - `SetupResult` interface → `packages/obsidian-plugin/src/features/core/types.ts` (new), consumed by `core/index.ts`.
  - `BINARY_NAME`, `INSTALL_PATH`, `PLATFORM_TYPES`/`Platform` → `packages/obsidian-plugin/src/features/migration/constants.ts` (new), consumed by `migration/services/detect.ts`.
  - Edit `packages/obsidian-plugin/src/main.ts` (remove the dead commented import block).
- **Phase 3** — `package.json` (root: add `build` script); `.github/workflows/release.yml` (add `main.js` provenance attestation on the 0.4.x line; trim 0.4.x release assets).
- **Phase 4** — `packages/obsidian-plugin/src/features/command-permissions/services/permissionCheck.ts`; root `package.json` (drop unused `npm-run-all`); `packages/obsidian-plugin/src/test-setup.ts`; `packages/test-site/eslint.config.js`; plus a repo-wide lint/type sweep.
- **Phase 5** — depends on PR #104 (`fix/100-windows-import-meta-url`) being merged; optional onnxruntime path-leak hardening in `packages/obsidian-plugin/bun.config.ts`.

---

## Phase 1 — Retire legacy `packages/mcp-server` (HIGHEST IMPACT)

**Why first:** kills the largest source-warning cluster the reviewer flagged — `packages/mcp-server/src/features/fetch/index.ts:28` (`fetch` instead of `requestUrl`), `packages/mcp-server/src/shared/makeRequest.ts:170/186/237` (unsafe `any`), `packages/mcp-server/src/shared/ToolRegistry.ts:176` (unsafe error) — plus removes the standalone-binary surface entirely. 0.4.x runs in-process; this package is dead weight on this branch.

**Files:**
- Delete: `packages/mcp-server/` (entire directory)
- Verify-only: `packages/obsidian-plugin/**` (no edits expected)

- [ ] **Step 1: Create the branch**

```bash
git checkout feat/http-embedded
git pull --ff-only origin feat/http-embedded
git checkout -b chore/retire-legacy-mcp-server
```

- [ ] **Step 2: Prove no live dependency exists (regression guard BEFORE deletion)**

Run:
```bash
grep -rn "@obsidian-mcp-tools/mcp-server\|packages/mcp-server" packages/obsidian-plugin/src --include='*.ts' --include='*.svelte' | grep -v -E '//|\* |ported|Kept in sync|Why this exists|0\.3\.x shipped'
```
Expected: **no output** (only doc-comments reference it; none are real imports). If any real `import ... from "@obsidian-mcp-tools/mcp-server"` or path import appears, STOP — this plan's premise is wrong; re-scope.

- [ ] **Step 3: Delete the package**

```bash
git rm -r packages/mcp-server
```

- [ ] **Step 4: Verify the workspace still resolves, type-checks, tests, and builds**

Run:
```bash
bun install
bun run check
cd packages/obsidian-plugin && bun test && bun bun.config.ts --prod && cd ../..
```
Expected: `bun run check` → all packages exit 0; `bun test` → pass (the only acceptable failures are the pre-existing `bindWithFallback` port-27200 env flake — confirm the failures, if any, are exclusively `bindWithFallback`); build → `Build successful`; `main.js` regenerated at repo root.

- [ ] **Step 5: Confirm `release.yml` 0.4.x path is unaffected**

Run:
```bash
grep -n "ships_binary\|0.3.x line only\|packages/mcp-server" .github/workflows/release.yml
```
Expected: every `packages/mcp-server` reference is inside a step gated `if: ... ships_binary == 'true'` / "0.3.x line only". These steps do **not** run on 0.4.x tags, so deletion is safe for 0.4.x releases. Do **not** edit these steps (they are inert on 0.4.x and `main`/0.3.x still needs them). Add a note to the PR body stating: "0.3.x releases are cut from `main`, which retains `packages/mcp-server`; cutting a 0.3.x tag from this branch is unsupported by design."

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(0.4): retire legacy packages/mcp-server (stdio binary)

0.4.x runs the MCP server in-process (HTTP-embedded); the standalone
stdio binary package is unused at runtime by the plugin (verified: zero
real imports — only doc-comment references). Removing it eliminates the
automated-review warning cluster sourced from packages/mcp-server
(fetch-vs-requestUrl, unsafe any in makeRequest/ToolRegistry) and shrinks
the scanned surface. 0.3.x releases are cut from `main`, which retains
this package; release.yml binary steps are gated `0.3.x line only` and
remain inert on the 0.4.x line.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Push + PR into `feat/http-embedded`**

```bash
git push -u origin chore/retire-legacy-mcp-server
gh pr create --repo istefox/obsidian-mcp-connector --base feat/http-embedded --head chore/retire-legacy-mcp-server --title "chore(0.4): retire legacy packages/mcp-server" --body "Removes the unused 0.3.x stdio-binary package from the 0.4.x line. Eliminates the automated-review warnings sourced from packages/mcp-server. No runtime imports from obsidian-plugin (verified). 0.3.x line (cut from main) is unaffected. Verification: bun run check 0 errors; bun test pass (bindWithFallback flake only); prod build OK."
```

---

## Phase 2 — Retire legacy `features/mcp-server-install` (HIGH IMPACT)

**Why second:** kills the second-largest cluster — `mcp-server-install/services/config.ts:59/79/112/189`, `status.ts:46`, `install.ts:145/418`, `uninstall.ts:73/75/76` (unsafe `any`, unused `plugin`, `err` stringification, `await` non-Promise). The module is not invoked in 0.4.x; only two tiny pieces are still imported live.

**Files:**
- Create: `packages/obsidian-plugin/src/features/core/types.ts`
- Create: `packages/obsidian-plugin/src/features/migration/constants.ts`
- Modify: `packages/obsidian-plugin/src/features/core/index.ts:2`
- Modify: `packages/obsidian-plugin/src/features/migration/services/detect.ts:5-9`
- Modify: `packages/obsidian-plugin/src/main.ts` (delete dead commented import block, lines ~31-38 and the comment at ~466)
- Delete: `packages/obsidian-plugin/src/features/mcp-server-install/` (entire directory, incl. its `*.test.ts`)

- [ ] **Step 1: Create the branch**

```bash
git checkout feat/http-embedded && git pull --ff-only origin feat/http-embedded
git checkout -b chore/retire-mcp-server-install
```

- [ ] **Step 2: Relocate the `SetupResult` type (verbatim) into `core`**

Create `packages/obsidian-plugin/src/features/core/types.ts`:

```typescript
/**
 * Result contract for a feature `setup()`. Relocated here from the
 * retired `mcp-server-install` module (0.3.x installer) — `core` is the
 * only live consumer in the 0.4.x line.
 */
export interface SetupResult {
  success: boolean;
  error?: string;
}
```

- [ ] **Step 3: Point `core/index.ts` at the new location**

In `packages/obsidian-plugin/src/features/core/index.ts`, replace line 2:

```typescript
// BEFORE
import type { SetupResult } from "../mcp-server-install/types";
// AFTER
import type { SetupResult } from "./types";
```

- [ ] **Step 4: Relocate the path constants (verbatim) into `migration`**

Create `packages/obsidian-plugin/src/features/migration/constants.ts`:

```typescript
/**
 * Legacy-binary path/name constants. Relocated from the retired
 * `mcp-server-install` module — `migration/services/detect.ts` is the
 * only live 0.4.x consumer (it must still recognise a leftover 0.3.x
 * binary on disk to drive the migration UX).
 */
export const BINARY_NAME = {
  windows: "mcp-server.exe",
  macos: "mcp-server",
  linux: "mcp-server",
} as const;

export const INSTALL_PATH = {
  macos: "~/Library/Application Support/obsidian-mcp-tools/bin",
  windows: "%APPDATA%\\obsidian-mcp-tools\\bin",
  linux: "~/.local/share/obsidian-mcp-tools/bin",
} as const;

export const PLATFORM_TYPES = ["windows", "macos", "linux"] as const;
export type Platform = (typeof PLATFORM_TYPES)[number];
```

- [ ] **Step 5: Point `detect.ts` at the new location**

In `packages/obsidian-plugin/src/features/migration/services/detect.ts`, replace the import block (currently lines ~5-9):

```typescript
// BEFORE
import {
  BINARY_NAME,
  INSTALL_PATH,
  type Platform,
} from "$/features/mcp-server-install/constants";
// AFTER
import {
  BINARY_NAME,
  INSTALL_PATH,
  type Platform,
} from "$/features/migration/constants";
```

- [ ] **Step 6: Remove the dead commented import block in `main.ts`**

In `packages/obsidian-plugin/src/main.ts`, delete the comment block at lines ~31-38 (the `// mcp-server-install setup was the 0.3.x ...` paragraph through `// import { setup as setupMcpServerInstall } from "./features/mcp-server-install";`) and shorten the comment at ~466 to a single line: `// 0.4.0: the in-process server has no binary to install.`

- [ ] **Step 7: Delete the module**

```bash
git rm -r packages/obsidian-plugin/src/features/mcp-server-install
```

- [ ] **Step 8: Verify no dangling references remain**

Run:
```bash
grep -rn "mcp-server-install" packages/obsidian-plugin/src --include='*.ts' --include='*.svelte'
```
Expected: **no output**. If any line remains (including `core/components/SettingsTab.svelte`), it must be a comment with no import — rewrite the comment to drop the stale path, or fix the import to the relocated module.

- [ ] **Step 9: Type-check + test + build**

Run:
```bash
bun run check
cd packages/obsidian-plugin && bun test && bun bun.config.ts --prod && cd ../..
```
Expected: all packages exit 0; tests pass (bindWithFallback flake only); `Build successful`.

- [ ] **Step 10: Commit + push + PR**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(0.4): retire features/mcp-server-install (0.3.x binary installer)

Not invoked in 0.4.x (in-process server, no binary). Relocated the two
pieces still imported live: SetupResult → features/core/types.ts;
BINARY_NAME/INSTALL_PATH/Platform → features/migration/constants.ts (the
migration UX still detects a leftover 0.3.x binary). Deletes the rest of
the module + its tests, eliminating the automated-review unsafe-any /
unused-var / err-stringify / await-non-Promise warnings sourced from
mcp-server-install/services/*.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push -u origin chore/retire-mcp-server-install
gh pr create --repo istefox/obsidian-mcp-connector --base feat/http-embedded --head chore/retire-mcp-server-install --title "chore(0.4): retire features/mcp-server-install" --body "Relocates SetupResult + binary path constants to their live consumers, deletes the legacy installer module. Eliminates the mcp-server-install/* automated-review warning cluster. Verification: bun run check 0 errors; bun test pass; prod build OK."
```

---

## Phase 3 — Build verification + release provenance (MEDIUM IMPACT)

**Why third:** directly resolves two dashboard `Recommendation` items: "Build verification skipped: no `build` script found in package.json" and "`main.js` release asset does not have a GitHub artifact attestation". Cheap, high signal-value with the reviewer.

**Files:**
- Modify: `package.json` (root — add `build` script)
- Modify: `.github/workflows/release.yml` (add `main.js` provenance on 0.4.x; trim 0.4.x assets)

- [ ] **Step 1: Branch**

```bash
git checkout feat/http-embedded && git pull --ff-only origin feat/http-embedded
git checkout -b chore/build-verification-and-provenance
```

- [ ] **Step 2: Add a root `build` script**

In root `package.json` `"scripts"` (currently has `check`, `release`, …), add:

```json
"build": "bun --filter '@obsidian-mcp-tools/obsidian-plugin' build"
```

- [ ] **Step 3: Verify the root build script works end-to-end**

Run:
```bash
bun run build
ls -la main.js manifest.json
```
Expected: `bun run check` runs (via the plugin `build` script) then `Build successful`; `main.js` present at repo root.

- [ ] **Step 4: Add `main.js` artifact attestation on the 0.4.x line in `release.yml`**

In `.github/workflows/release.yml`, after the plugin build step and **before** the release-upload step, add a step mirroring the existing `attest-build-provenance@v4` usage (currently gated `0.3.x line only` for `packages/mcp-server/dist/*`). Add the 0.4.x counterpart:

```yaml
      - name: Generate artifact attestation for the plugin bundle (0.4.x line)
        if: steps.release_line.outputs.ships_binary != 'true'
        uses: actions/attest-build-provenance@v4
        with:
          subject-path: "main.js"
```

(Use the exact `steps.release_line.outputs.*` id already defined in the workflow — verify the id name with `grep -n 'release_line\|ships_binary' .github/workflows/release.yml` and match it.)

- [ ] **Step 5: Trim 0.4.x release assets to the Obsidian-supported set**

In `release.yml`, the 0.4.x upload step currently uploads `packages/obsidian-plugin/releases/obsidian-plugin-*.zip,main.js,manifest.json`. The reviewer flags non-`main.js`/`manifest.json`/`styles.css` files as unsupported. Change the 0.4.x `artifacts:` value to:

```
main.js,manifest.json
```

(Keep the zip only if Stefano wants a convenience download; if kept, accept the cosmetic "additional files" warning. Default per this plan: drop it.)

- [ ] **Step 6: Validate the workflow file**

Run:
```bash
grep -n "attest-build-provenance\|subject-path\|artifacts:\|ships_binary" .github/workflows/release.yml
```
Expected: a 0.4.x attestation step keyed off the same output as the 0.3.x one; 0.4.x `artifacts:` = `main.js,manifest.json`; 0.3.x steps unchanged.

- [ ] **Step 7: Commit + push + PR** (same pattern as Phase 1 Step 7; title `chore(0.4): add build script + main.js release attestation`).

---

## Phase 4 — Lint / quality cleanup (LOWER IMPACT)

**Why fourth:** each item is one or two warnings, several in non-shipped files (`test-setup.ts`, `packages/test-site`). Real but low individual weight.

**Files:**
- Modify: `packages/obsidian-plugin/src/features/command-permissions/services/permissionCheck.ts:150,152,165`
- Modify: root `package.json` (remove unused `"npm-run-all"`)
- Modify: `packages/obsidian-plugin/src/test-setup.ts:201,210,216`
- Modify: `packages/test-site/eslint.config.js:15`

- [ ] **Step 1: Branch** `chore/lint-cleanup` off `feat/http-embedded`.

- [ ] **Step 2: `permissionCheck.ts` — use popout-safe timers**

The reviewer wants `activeWindow.setTimeout()/clearTimeout()` for popout-window compatibility. In `packages/obsidian-plugin/src/features/command-permissions/services/permissionCheck.ts`:
- Line ~150: `let timeoutHandle: ReturnType<typeof activeWindow.setTimeout> | undefined;`
- Line ~152: `timeoutHandle = activeWindow.setTimeout(` (keep args identical)
- Line ~165: `if (timeoutHandle) activeWindow.clearTimeout(timeoutHandle);`

`activeWindow` is an Obsidian global. Confirm it is available in this module's context (it is a plugin-runtime module). If `activeWindow` is not in scope, import nothing — it is a global injected by Obsidian; add an ESLint/TS ambient note only if `tsc` complains. Run `bun run check` after.

- [ ] **Step 3: Verify timer change does not regress the permission tests**

Run: `cd packages/obsidian-plugin && bun test src/features/command-permissions`
Expected: PASS. If the test mock lacks `activeWindow`, add `activeWindow` to the obsidian mock in `test-setup.ts` mapping to global `setTimeout/clearTimeout` (recorder-compatible), then re-run.

- [ ] **Step 4: Remove unused `npm-run-all` root devDependency**

Verify it is unused:
```bash
grep -rn "npm-run-all\|run-s\|run-p" package.json packages/*/package.json .github/workflows scripts 2>/dev/null | grep -v '"npm-run-all"'
```
Expected: no usage (scripts use `bun --filter`). Then remove the `"npm-run-all": "^4.1.5"` line from root `package.json` `devDependencies`, run `bun install`, commit the lockfile change.

- [ ] **Step 5: `test-setup.ts` globalThis → activeDocument note**

`test-setup.ts:201/210/216` use `globalThis.__svelteMockCalls`. This is a **test-only mock recorder**, never shipped. The reviewer's `activeDocument` advice targets shipped popout-window code, not test recorders. Two acceptable resolutions (pick one, document in the commit):
  - (a) Rename the recorder off `globalThis` to a module-scoped singleton exported from `test-setup.ts` and update the three usages + the documented reset snippet; OR
  - (b) Leave as-is and add a top-of-file ESLint disable comment scoped to the recorder with a one-line justification ("test-only mock recorder; not shipped; `activeDocument` rule N/A").
Default: (a) — removes the flag at the source.

- [ ] **Step 6: `packages/test-site/eslint.config.js:15`**

`packages/test-site` is the SvelteKit harness, **not part of the shipped product** (CLAUDE.md). The flag is a typescript-eslint flat-config typing quirk (`InfiniteDepthConfigWithExtends`). Resolution: pin the offending spread with the documented typed-config helper, or add the package to the reviewer-ignored set if the portal supports per-path ignores. Minimal concrete fix: wrap the config export in `ts.config(...)` already used — change line ~15 area so the `...ts.configs.recommended` spread is passed through `ts.config()` typing (run `cd packages/test-site && bunx eslint --print-config eslint.config.js >/dev/null` to confirm no config-load error after the change). If the harness cannot be made clean cheaply, document it as accepted (non-shipped) in the PR.

- [ ] **Step 7: Repo-wide residual sweep**

Run the project's own gates and fix anything they report (this is the objective done-condition, not a placeholder):
```bash
bun run check
cd packages/obsidian-plugin && bun test && cd ../..
```
Expected: 0 type errors; tests pass (bindWithFallback flake only). Fix every non-flake failure before commit.

- [ ] **Step 8: Commit + push + PR** (title `chore(0.4): automated-review lint cleanup`).

---

## Phase 5 — #100 + residual path-leak (DEPENDENCY / OPTIONAL)

- [ ] **Step 1: Land #100.** PR #104 (`fix/100-windows-import-meta-url`) is already open into `feat/http-embedded`. It must be **merged** and then a **Windows load smoke** performed (not reproducible on macOS/Linux) before issue #100 is closed. This is a code-correctness item the "every version" scanner checks on Windows.

- [ ] **Step 2 (optional, byte-reproducible builds): neutralise residual onnxruntime path leak.** `main.js` still embeds `…/node_modules/onnxruntime-web/dist` build-machine path **strings** (not `fileURLToPath`'d → no crash; dead because wasm paths are CDN-pinned). For build reproducibility, add a `bun.config.ts` `define`/replace for the onnxruntime path source the same way `import.meta.url` was handled in #104. Verify with `grep -oE '/Users/|/home/runner/' main.js` → no build-machine paths. Out of #100's scope; do only if reproducibility is a goal.

---

## Self-Review

**1. Spec coverage** (every dashboard item → a task):
- RELEASES "additional files (binaries, zip)" → Phase 1 (binaries gone with package; 0.3.x-gated) + Phase 3 Step 5 (zip trimmed). ✓
- RELEASES "main.js no attestation" → Phase 3 Step 4. ✓
- SOURCE `npm-run-all` (package.json:26) → Phase 4 Step 4. ✓
- SOURCE `fetch` vs `requestUrl` (packages/mcp-server) → Phase 1. ✓
- SOURCE unsafe error/any in `ToolRegistry`/`makeRequest` (packages/mcp-server) → Phase 1. ✓
- SOURCE unsafe-any / unused / err-stringify / await-non-Promise / `.mcpServers` (mcp-server-install/*) → Phase 2. ✓
- SOURCE `setTimeout`/`clearTimeout` (permissionCheck.ts) → Phase 4 Step 2. ✓
- SOURCE `globalThis` (test-setup.ts) → Phase 4 Step 5. ✓
- SOURCE unsafe arg (test-site/eslint.config.js:15) → Phase 4 Step 6. ✓
- SOURCE unsafe-any `main.ts:104` (0.3.12 line; on feat/http-embedded that line differs) → covered by Phase 4 Step 7 repo-wide sweep (objective: 0 type errors / clean lint), with the honest caveat that the 0.4.x-specific finding set is unknown until 0.4.x is reviewed. ✓
- BUILD VERIFICATION "no build script" → Phase 3 Step 2. ✓
- #100 Windows crash → Phase 5 Step 1 (PR #104). ✓

**2. Placeholder scan:** relocated `SetupResult` and path constants are shown verbatim; import edits show before/after; commands have expected outputs. The only "run tool then fix what it reports" steps (Phase 4 Step 6/7) are objective verification loops with exact commands and a clear green done-condition, not vague TODOs.

**3. Type consistency:** `SetupResult { success: boolean; error?: string }` is identical to the deleted original; `BINARY_NAME`/`INSTALL_PATH`/`PLATFORM_TYPES`/`Platform` are copied verbatim from `mcp-server-install/constants/paths.ts`; import specifiers updated to `./types` (core) and `$/features/migration/constants` (detect).

**Residual honest gaps (by design, not fixable here):** exact numeric "100" is not guaranteeable (partial public rubric); the score only updates when **0.4.x is the released/submitted version** — a protected-`main` decision reserved to Stefano.

---

## Execution order (impact-ranked)

1. **Phase 1** — retire `packages/mcp-server` (largest cluster).
2. **Phase 2** — retire `features/mcp-server-install` (second cluster).
3. **Phase 3** — build script + `main.js` attestation + asset trim (two `Recommendation`s).
4. **Phase 4** — lint cleanup (small, partly non-shipped files).
5. **Phase 5** — land #100 (PR #104) + Windows smoke; optional path-leak hardening.

Each phase is an independent branch → PR into `feat/http-embedded`. None touches `main`.
