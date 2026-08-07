# Contributing to Unphased

Thanks for looking. Unphased is two Premiere Pro plugins over one DSP engine, so
the most useful thing to know before touching anything is **which copy of a file
is the real one**.

## The one rule: `engine/src/` is the source of truth

```
engine/src/*.js   ← edit here
      │
      └─ uxp/scripts/build-engine.js  (ESM → CommonJS)
             │
             └─ uxp/js/engine/*.js    ← generated, committed, DO NOT hand-edit

cep/js/pairing.js ← edit here
      │
      └─ copied by the same script to uxp/js/pairing.js  ← generated
```

The generated files are committed so the UXP plugin folder loads as-is. After
changing anything under `engine/src/` or `cep/js/pairing.js`:

```bash
cd uxp && npm run build:engine
```

`npm run lint` regenerates into a temp buffer and **fails if the committed output
has drifted**, so CI catches a forgotten regeneration. Three engine modules are
deliberately *not* shared — `decode.js` (spawns ffmpeg), `progress.js` (writes
NDJSON to stdout) and `wavFile.js` (`node:fs`); their UXP counterparts are
`uxp/js/audio.js`, the runner's event callbacks, and UXP's own `fs`.

## Running the checks

No dependencies to install — both suites are plain Node.

```bash
cd engine && npm test                # 89 tests — the shared DSP
cd uxp && npm run lint && npm test   # 31 tests — the UXP plugin
```

**Node 22 or 24** to run the suites — `node --test "glob"` only expands its own
globs from Node 22 on. (The CEP panel itself still only needs system Node ≥ 18
at runtime.) Engine tests that need `ffmpeg` on PATH skip themselves when it is
absent; CI installs it so they run there.

If a change touches the DSP, say in the PR what it does to **null depth** on the
`testmedia/` fixtures — that number is the point of the whole project, and
`engine/test/align.e2e.test.js` asserts against `testmedia/ground-truth.json`.

## Layout

| Path | What it is |
| --- | --- |
| `engine/` | Standalone Node DSP engine, zero dependencies. The shared brain. |
| `cep/` | CEP extension for Premiere 24/25 — UI + ExtendScript host layer. |
| `uxp/` | UXP plugin for Premiere 26+ — UI + UXP host layer + native decoder. |
| `uxp/native/` | The bundled FFmpeg decode addon (C++). See its own README. |
| `docs/` | Architecture notes. Read [`docs/architecture.md`](docs/architecture.md) first. |
| `testmedia/` | Generated fixtures with known ground truth. |

Regenerate the fixtures with `node engine/cli.js gen-fixtures testmedia`.

## Working on the plugins

**CEP** — `powershell -ExecutionPolicy Bypass -File cep\scripts\install-panel.ps1`
junctions `cep/` into your CEP extensions folder, so edits are live after a panel
reload. Devtools at `http://localhost:8088`.

**UXP** — load with the UXP Developer Tool, or `uxp service start` then
`uxp plugin load --apps premierepro` from `uxp/`.

Keep the two panels' UI in step where it makes sense: `cep/index.html` and
`uxp/index.html` carry near-identical instruction text, and `engine/test/panel.test.js`
plus `uxp/tests/panel.test.js` assert on panel markup — a UI change that breaks
one of those tests is usually the test telling you the other panel needs the same
edit.

Note that UXP's native `<button>` ignores author CSS backgrounds, so the UXP
panel deliberately avoids `<select>`, checkboxes and buttons for anything styled;
segmented controls and toggle chips are `<div>`s on purpose.

## Style

Match the file you are in. Broadly: 4-space indent in JS, double quotes in the
UXP tree, single quotes in the CEP tree, and comments that explain *why* rather
than restating the code. `cep/jsx/host.jsx` is ExtendScript — ES3 only, no
`const`/`let`/arrow functions, no `JSON` (use the bundled `json2.jsx`).

## Versioning and releases

Both plugins ship off one tag and must carry the same version — CI fails if
`uxp/manifest.json` and `cep/VERSION` disagree.

```bash
cd uxp && node scripts/set-version.js 0.3.0 --with-cep
```

That updates the UXP manifest, `package.json`, the panel footer, the version
`ping()` reports, and the CEP manifest and `VERSION`. Then add a
[`CHANGELOG.md`](CHANGELOG.md) entry, commit, and push a `v0.3.0` tag —
`.github/workflows/release.yml` builds the `.ccx`, zips the CEP bundle and
publishes the GitHub Release.

The native addon (`uxp/win/x64/unphased.uxpaddon`) is **committed** rather than
built in CI — rebuilding a static FFmpeg on every run for a file that changes
twice a year is not worth it. Rebuild it only when the decoder changes; see
[`uxp/native/README.md`](uxp/native/README.md).

## Reporting bugs

Alignment bugs are much easier to act on with the panel's **Log** contents and
the **Results** row (Delay / Drift / Pol / Null) pasted in, plus what the media
actually is: recorder, sample rate, channel count, and whether several tracks
share one file. A `Null` above 40 dB with a delay of exactly ±0.0 ms almost
always means a source-channel mix-up rather than an engine bug — check
**Sources** first.

## License

By contributing you agree your work is licensed under the [MIT License](LICENSE),
the same as the rest of Unphased's own code.
