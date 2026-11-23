# Vector probe (#680)

Compares the vectors each embedding model produces on WebGPU (main thread)
with the ones it produces on WASM (embedding worker), inside a real Obsidian
vault, through the plugin's own bundle. It changes no setting and writes
nothing to the vault or to the search index. Model files it downloads go
to Obsidian's browser cache, where the plugin keeps its own.

It needs a Mac whose Obsidian resolves WebGPU, the `obsidian` command line
tool, and a vault whose plugin folder is linked to this repository (Labs).
All commands run from `packages/obsidian-plugin`.

## Run

1. Build the diagnostic bundle and the probe file:

   ```sh
   bun run build:vector-probe
   ```

   The build prints a `DIAGNOSTIC BUNDLE` warning. That bundle is the
   production one plus the probe hook; `scripts/zip.ts` refuses to package it.

2. Reload the plugin:

   ```sh
   obsidian vault=Labs plugin:reload id=mcp-tools-istefox
   ```

3. Start the probe. It returns at once:

   ```sh
   P="$PWD/releases/vector-probe.cjs"
   obsidian vault=Labs eval code="delete require.cache[require.resolve('$P')]; require('$P').start({out:'$PWD/releases/vector-probe-report'})"
   ```

   The `delete` drops the copy of the probe file Obsidian loaded earlier,
   so a rebuilt one is picked up without restarting the app.
   `No vector probe hook in this vault` means step 1 or 2 did not take.
   To run one model only, add `only`, with the labels `MiniLM`,
   `Multilingual E5 base`, `EmbeddingGemma 300M`:
   `start({out:'...', only:['MiniLM']})`.

4. Poll until the output no longer starts with `RUNNING`. The first run
   downloads every model variant and takes several minutes; Obsidian may
   stutter while a WebGPU case runs.

   ```sh
   obsidian vault=Labs eval code="require('$P').status()"
   ```

   The finished report is also in `releases/vector-probe-report.txt` and
   `.json`.

5. Collect the backend log lines the run produced:

   ```sh
   grep '"semantic-search: model backend"' ../../diagnostic.log | tail -20
   ```

   One line per load. A WASM load logs `backend: "wasm"`,
   `machineBackend: "webgpu"`, `thread: "worker"`; a WebGPU load logs
   `backend: "webgpu"`, `thread: "main"`. The probe loads every model on
   both, EmbeddingGemma included, so Gemma lines with `thread: "main"` are
   the probe's control and not what the plugin does on its own. A WASM
   line with `thread: "main"` means a worker gave up: that case is
   `INVALID` in the report.

6. Put the normal build back:

   ```sh
   bun run build
   obsidian vault=Labs plugin:reload id=mcp-tools-istefox
   ```

## Reading the report

One block per case. A model whose two backends are not given the same dtype
runs once as shipped and once per dtype forced on both.

- `verdict`: `OK` when every sentence's cosine between the two backends is
  at least 0.99. `MISMATCH` when it is not and both sides loaded the same
  dtype: that is a finding. `INCONCLUSIVE` when it is not but the two sides
  loaded different weights. `INVALID` when the case did not test what it
  claims (a load failed, or the WASM side ran on the main thread); its
  numbers are not reported.
- `collapse`: mean pairwise cosine over the eight sentences on one backend.
  Read it against the same model's other backend, not as an absolute: a
  collapsed model is near 1 on one side only.
- `files`: the `.onnx` files the library reported, the evidence for which
  weights each side loaded.
- `ranking`: twelve notes, eight queries with one expected note, one
  nonsense query. On collapsed vectors the nonsense query scores as high
  as the real ones. The texts are the probe's own, so the numbers compare
  two backends of one model and nothing else.
- EmbeddingGemma is a control: production pins it to WASM because its
  WebGPU vectors were wrong in Obsidian. Its `as shipped` case loads
  different weights per backend and proves nothing; the two forced-dtype
  cases do. If neither is a `MISMATCH` the report ends with a warning,
  and the other verdicts cannot be trusted as they stand.
