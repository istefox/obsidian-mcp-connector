/**
 * Builds the vector probe (#680) into one file `obsidian eval` can
 * `require`. Prints the path. The output lands in `releases/`, which is
 * gitignored, and is never part of the plugin.
 */
import { join } from "path";

const outdir = join(import.meta.dir, "..", "releases");
const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "vector-probe", "entry.ts")],
  outdir,
  naming: "vector-probe.cjs",
  target: "node",
  format: "cjs",
});
if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exit(1);
}
console.log(join(outdir, "vector-probe.cjs"));
