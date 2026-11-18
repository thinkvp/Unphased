# Contributing to Unphased

Thanks for looking. Unphased is a Premiere Pro plugin over a standalone DSP
engine, so the most useful thing to know before touching anything is **which
copy of a file is the real one**.

## The one rule: `engine/src/` is the source of truth

```
engine/src/*.js   ← edit here
      │
      └─ uxp/scripts/build-engine.js  (ESM → CommonJS)
             │
             └─ uxp/js/engine/*.js    ← generated, committed, DO NOT hand-edit
```

`uxp/js/pairing.js` is the exception in the other direction: it is a
hand-maintained panel module that the engine test suite requires directly, so a
change to it is covered by `cd engine && npm test` rather than by the transpile
check.

The generated files are committed so the plugin folder loads as-is. After
changing anything under `engine/src/`:

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
cd engine && npm test                # 137 tests — the DSP
cd uxp && npm run lint && npm test   # 38 tests — the plugin
```

**Node 22 or 24** to run the suites — `node --test "glob"` only expands its own
globs from Node 22 on. Node is a development dependency only; the shipped plugin
bundles its own decoder and needs nothing installed.

Two sets of tests skip themselves rather than fail when their dependency is
missing. Both are worth un-skipping before you trust a green run:

| Skipped when | Tests | To run them |
| --- | --- | --- |
| No ffmpeg | 7 engine tests, incl. every job-protocol e2e | Install ffmpeg at `C:\ffmpeg\bin\ffmpeg.exe`, or set `UNPHASED_FFMPEG` to its path |
| No native harness | 5 decode-core tests | Build `native/build/decode_smoke` — see [`uxp/native/README.md`](uxp/native/README.md) |

Both are covered in CI, and **every job fails on a non-zero skip count** — a
skipped test reads as green otherwise, which is the whole problem with them.
Engine CI installs ffmpeg; macOS native CI builds the decode harness from source
(Windows CI can't, since the static FFmpeg libs under `uxp/native/third_party/`
are not committed). So the decode core is verified on macOS only — build the
harness locally on Windows when you change it.

## The three CI workflows

| Workflow | Runs on | What only it can prove |
| --- | --- | --- |
| `engine-ci.yml` | Linux, Node 22/24 | The DSP, with ffmpeg present |
| `uxp-ci.yml` | Windows, Node 22/24 | The engine transpile is not stale, and the `.ccx` packages |
| `mac-native-ci.yml` | macOS | The native decoder compiles, is universal, and decodes bit-exactly |

The macOS job builds a static FFmpeg, which takes 15–25 minutes cold. It is
cached on the hash of `uxp/scripts/build-ffmpeg-mac.sh` and only runs when
something under `uxp/native/` changes, so most pull requests never pay for it.

If a change touches the DSP, say in the PR what it does to **null depth** on the
`testmedia/` fixtures — that number is the point of the whole project, and
`engine/test/align.e2e.test.js` asserts against `testmedia/ground-truth.json`.

## Layout

| Path | What it is |
| --- | --- |
| `engine/` | Standalone Node DSP engine, zero dependencies. The brain. |
| `uxp/` | The Premiere 26+ plugin — UI + UXP host layer + native decoder. |
| `uxp/native/` | The bundled FFmpeg decode addon (C++). See its own README. |
| `docs/` | Architecture notes. Read [`docs/architecture.md`](docs/architecture.md) first. |
| `testmedia/` | Generated fixtures with known ground truth. |

Regenerate the fixtures with `node engine/cli.js gen-fixtures testmedia`.

## Working on the plugin

Load it with the UXP Developer Tool, or `uxp service start` then
`uxp plugin load --apps premierepro` from `uxp/`.

`uxp/scripts/build-ccx.js` decides which files an installed plugin actually
gets — add a runtime file to the panel and you must add it there too, or it
works in the dev loop and is missing from the `.ccx`. `uxp/tests/panel.test.js`
asserts on panel markup and on that staging list, so a UI change that breaks it
is usually the test telling you the two have drifted apart.

Note that UXP's native `<button>` ignores author CSS backgrounds, so the panel
deliberately avoids `<select>`, checkboxes and buttons for anything styled;
segmented controls and toggle chips are `<div>`s on purpose.

`npm run build` in `uxp/` stages the runtime files only and zips them
(forward-slash entries) into `dist/Unphased-UXP-<version>.ccx`, failing if the
generated engine has drifted, if no native addon is present, or if the package
comes out suspiciously large. A local build carries only the committed Windows
addon; the macOS slice is built from source by CI, so only a tagged release
produces a genuinely cross-platform `.ccx`.

Two constraints worth knowing before you change the panel's shape:

- **The DSP runs on UXP's scripting thread.** There is no child process, so long
  jobs block Premiere's UI in bursts and cancellation can only take effect
  between segments.
- **`manifest.json`'s `host` must stay a single object.** An array there is the
  UXP-devtools dev-loop format; using it in a packaged build causes a generic,
  hard-to-diagnose "Couldn't install plugin" failure.

## Style

Match the file you are in. Broadly: 4-space indent and double quotes in the
`uxp/` tree, 2-space indent and single quotes in `engine/`, and comments that
explain *why* rather than restating the code.

## Versioning and releases

```bash
cd uxp && node scripts/set-version.js 0.3.0
```

That updates the manifest, `package.json`, the panel footer and the version
`ping()` reports, so the number cannot drift between them. Then add a
[`CHANGELOG.md`](CHANGELOG.md) entry, commit, and push a `v0.3.0` tag.
`.github/workflows/release.yml` then builds the macOS addon from source,
packages the cross-platform `.ccx`, and publishes the GitHub Release.

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
