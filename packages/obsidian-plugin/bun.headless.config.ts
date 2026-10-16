#!/usr/bin/env bun
/*
 * Bundles the headless server into ONE self-contained executable,
 * `dist/headless/obsidian-mcp-headless.js`, which runs under plain Node
 * 24.11 or newer (the first Node 24 LTS) with no node_modules next to it.
 *
 * The bundle is CommonJS. Node loads a file with no package.json above it,
 * and an extensionless copy on PATH, as CommonJS without relying on module
 * detection. `import.meta` does not exist in CommonJS, so the one use
 * left in the graph is defined away and the build fails if any remains.
 * A `package.json` beside the bundle keeps it CommonJS when it runs from
 * here, below this package's `"type": "module"`.
 *
 * It shares the tool and transport code with the desktop plugin and
 * changes none of it. Everything that differs lives in this file and in
 * `src/headless`:
 *
 * - `obsidian` (declarations only) is aliased to the runtime shim.
 * - The shared composition root imports the desktop tool registration
 *   from `$/features/mcp-tools`, which also pulls in the settings UI and
 *   the desktop-only tools. That import is pointed at
 *   `src/headless/registerTools.ts`, the vault tools alone. The semantic
 *   search feature takes its mutex from `$/features/command-permissions`,
 *   which pulls in a modal and the Svelte runtime. That import is pointed
 *   at the module the mutex really lives in. Each redirect must be used,
 *   or the build fails.
 * - A `.svelte` file reached through a barrel becomes a stub that throws
 *   when called.
 * - Shared code reaches timers as `window.setTimeout`. The bundle runs in
 *   Node, where `window` does not exist, so those four calls are
 *   rewritten to `globalThis`. (Defining a `window` at run time is not an
 *   option: libraries take it as a sign of a browser.)
 *
 * No `browser` condition here: the desktop config selects browser builds
 * for a few packages, and this one runs in Node.
 */
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outdir = join(import.meta.dir, "dist/headless");
const outfile = join(outdir, "obsidian-mcp-headless.js");
const shim = join(import.meta.dir, "src/headless/obsidianShim.ts");

/** Imports of shared modules that the bundle must not reach, and where they go. */
const REDIRECTS: ReadonlyArray<{ from: RegExp; to: string }> = [
  {
    from: /^\$\/features\/mcp-tools$/,
    to: join(import.meta.dir, "src/headless/registerTools.ts"),
  },
];
const redirected = new Set<RegExp>();

/** The timer calls the define below rewrites, each of which the graph uses. */
const REWRITTEN_TIMERS = ["setTimeout", "clearTimeout"];

/** `window.<name>` reads in bundled libraries, on paths Node never takes. */
const KNOWN_WINDOW_PROPERTIES = [
  "addEventListener",
  "removeEventListener",
  "document",
  "innerWidth",
  "location",
  "parent",
];

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "src/headless/main.ts")],
  outdir,
  naming: "obsidian-mcp-headless.js",
  target: "node",
  format: "cjs",
  minify: true,
  sourcemap: "none",
  banner: "#!/usr/bin/env node",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    "import.meta.filename": "__filename",
    "window.setTimeout": "globalThis.setTimeout",
    "window.clearTimeout": "globalThis.clearTimeout",
    "window.setInterval": "globalThis.setInterval",
    "window.clearInterval": "globalThis.clearInterval",
  },
  plugins: [
    {
      name: "redirect-desktop-only-imports",
      setup(build) {
        for (const redirect of REDIRECTS) {
          build.onResolve({ filter: redirect.from }, () => {
            redirected.add(redirect.from);
            return { path: redirect.to };
          });
        }
      },
    },
    {
      name: "svelte-stub",
      setup(build) {
        build.onLoad({ filter: /\.svelte$/ }, () => ({
          contents:
            'export default function () { throw new Error("Svelte components are not available in the headless build"); }',
          loader: "js",
        }));
      },
    },
    {
      name: "obsidian-shim",
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: shim }));
      },
    },
  ],
});

if (!result.success) {
  console.error("Headless build failed");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const redirect of REDIRECTS) {
  if (!redirected.has(redirect.from)) {
    console.error(
      `Headless build failed: no import matched the redirect ${redirect.from}, so the bundle would carry the shared module it stands in for`,
    );
    process.exit(1);
  }
}

if ((await readFile(outfile, "utf8")).includes("import.meta")) {
  console.error("Headless build failed: import.meta left in a CommonJS bundle");
  process.exit(1);
}

// Guards for the `window` rewrite above. The rewrite is a define, which says
// nothing when it stops matching, so the output is checked instead.
const bundle = await readFile(outfile, "utf8");

// 1. Every timer call the shared code makes through `window` was rewritten,
//    and at least one site of each kind the graph is known to have was found.
const leftTimers = bundle.match(
  /(?<![\w$.])window\.(?:set|clear)(?:Timeout|Interval)\b/g,
);
if (leftTimers) {
  console.error(
    `Headless build failed: ${leftTimers.length} timer call(s) still go through window (${[...new Set(leftTimers)].join(", ")}), which does not exist in Node. The define for them in this file no longer matches.`,
  );
  process.exit(1);
}
for (const name of REWRITTEN_TIMERS) {
  if (!bundle.includes(`globalThis.${name}(`)) {
    console.error(
      `Headless build failed: no call of ${name} was found in the bundle. If the shared code stopped using window.${name}, drop it from REWRITTEN_TIMERS.`,
    );
    process.exit(1);
  }
}

// 2. A property of `window` or a use of Obsidian's `activeWindow` that is not
//    already known. The known ones sit in libraries, on paths a Node run does
//    not take. A new one is code that will fail in Node, or that needs a
//    decision, so it fails the build until it is added here on purpose.
const windowUses = new Set(
  bundle.match(/(?<![\w$.])window\.[A-Za-z_$][\w$]*/g) ?? [],
);
const unknown = [...windowUses]
  .map((use) => use.slice("window.".length))
  .filter((name) => !KNOWN_WINDOW_PROPERTIES.includes(name));
if (/(?<![\w$.])(?:activeWindow|activeDocument)\b/.test(bundle)) {
  unknown.push("activeWindow or activeDocument");
}
if (unknown.length > 0) {
  console.error(
    `Headless build failed: the bundle reads ${unknown.join(", ")} from the browser. Node has none of it. Handle it in src/headless, or add it to KNOWN_WINDOW_PROPERTIES in this file if it sits on a path a Node run never takes.`,
  );
  process.exit(1);
}

await writeFile(join(outdir, "package.json"), '{ "type": "commonjs" }\n');
await chmod(outfile, 0o755);
console.warn(`Built ${outfile}`);
