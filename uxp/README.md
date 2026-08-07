# Unphased (UXP)

Mic alignment and phase correction for Premiere Pro — a UXP plugin with a
bundled FFmpeg decoder and no external dependencies at all.

Part of the [Unphased](../README.md) project. On Premiere 24/25, use the
[CEP version](../cep/README.md) instead.

- **No ffmpeg install, no Node install.** The decoder is a bundled native hybrid
  addon (`win/x64/unphased.uxpaddon`, ~2.2 MB) — a trimmed, statically linked
  LGPL FFmpeg 8.1.2 with audio demuxers and decoders only. The DSP runs in the
  panel itself. Nothing on PATH, nothing to download.
- **Tiny install.** `npm run build` produces a ~1.3 MB `.ccx`.

## Status

The JS layers are covered offline by `npm test` (31 tests), including a full
run against the `testmedia/` fixtures whose ground truth the CEP panel is also
verified against, and the native decode core is verified bit-exact against those
same WAVs. **The host layer (`js/premiere.js`) has not yet been exercised against
a live Premiere 26 session** — that is the remaining verification step.

| Area | State |
| --- | --- |
| Shared DSP (`js/engine/`) | Generated from `../engine/src` by `scripts/build-engine.js`; exports and numbers checked against the ESM source |
| Native FFmpeg addon | Windows x64 committed and self-contained (imports only `bcrypt`/`user32`/`kernel32`); macOS universal (arm64 + x86_64) built from source by CI. Decode verified bit-exact on both, incl. AAC frame-boundary trimming and per-channel selection |
| Decode layer (`js/audio.js`) | Padding, cancel checks and UI yields covered by tests |
| Runner (`js/runner.js`) | End-to-end offline: mono, stereo preservation, failure handling |
| Host ops (`js/premiere.js`) | Written against the documented UXP API — **needs live verification** |
| UI (`js/main.js`, `index.html`) | Ported from the CEP panel; DOM wiring checked statically |
| Packaging | `npm run build` → `dist/Unphased-UXP-<version>.ccx`, one package carrying all three platform addons |
| macOS | Addon builds universal and passes the decode-core tests in CI (`.github/workflows/mac-native-ci.yml`); **the panel has never been run in Premiere on a Mac** |

## Architecture (4 layers)

1. **DSP (pure, shared):** `js/engine/*.js` — generated CommonJS transpiles of
   `../engine/src/*.js`, which stays the single source of truth and is what
   `node --test` runs. `npm run lint` regenerates and fails if the committed
   output has drifted. `js/pairing.js` is `../cep/js/pairing.js`, copied by the
   same script.
2. **Audio (JS → native):** `js/audio.js` — wraps the addon's `probe`/`decode`,
   reproduces the front/tail padding ffmpeg's `adelay`/`apad` gave the CEP path,
   and yields to the UI plus checks for cancellation before every decode.
3. **Runner:** `js/runner.js` — the port of `engine/cli.js run`. Same job schema,
   same event names, no scratch files, and rendering decodes **one channel at a
   time** at the source's native rate.
4. **Host (JS → UXP DOM):** `js/premiere.js` — scan, import, place, mute, all
   inside `lockedAccess` + `executeTransaction`.

### Host API notes

- `SequenceEditor.createOverwriteItemAction` **creates the track** when the audio
  track index passed exceeds the track count. That removes the CEP host's
  undocumented QE `addTracks` dance entirely — there is no add-track API in UXP
  and none is needed.
- UXP exposes **no `nodeId`** on track items. Clips are addressed by
  `(trackIndex, clipIndex)` and re-fetched fresh inside each transaction rather
  than held across an await, which is also what keeps host objects valid.
- Scanning is two-pass: timing first, media paths second.
  `getMediaFilePath()` yields to the host and invalidates transient
  `TickTime`/trackItem handles, so it must not be interleaved with the timing
  reads.
- Selection is read per clip via `trackItem.getIsSelected()` —
  `Sequence.getSelection()` returns a selection group with no positional mapping
  back to tracks.

### Differences you can see, versus the CEP panel

Both plugins run the same DSP and produce the same numbers. What differs:

- **The panel blocks in bursts.** There is no child process to offload to, so the
  DSP runs on UXP's scripting thread. Cancel takes effect after the segment in
  flight.
- **No `<select>`, no checkboxes.** UXP's native `<button>` ignores author CSS
  backgrounds, and this port avoids the form widgets entirely: Time/Phase/Scope
  are segmented controls, REF/TGT are toggle chips, and the per-track source
  picker is a chip that **cycles** through the file's channels on click.
- **Settings are shorter.** node/engine/ffmpeg paths are gone — there is nothing
  external to point at. Only the rendered-audio folder remains.
- **Unsaved projects** fall back to the plugin's data folder rather than `%TEMP%`.

## Develop & test

- **Load:** UXP Developer Tool, or the CLI: `uxp service start`, then
  `uxp plugin load --apps premierepro` from this folder.
- **Offline checks:** `npm run lint` (engine-transpile drift + parse gate) and
  `npm test`.
- **After changing the shared engine:** `npm run build:engine`, then re-run both.

## Install (users)

**Requires Premiere Pro 26.0+**, on Windows x64 or macOS (Apple Silicon or
Intel — the addon is universal). The bundled FFmpeg decoder is a UXP hybrid
addon; Premiere 25.x loads the panel and then reports "Addon is not supported",
so 26.0 is the real floor. On older Premiere versions, use the
[CEP version](../cep/README.md), which is Windows-only.

The macOS build is a **beta**: CI proves the decoder compiles universal and
decodes bit-exactly, but the panel has not been run in Premiere on a Mac.

1. Download `Unphased-UXP-<version>.ccx` from the
   [Releases page](https://github.com/thinkvp/Unphased/releases).
2. Double-click it. Creative Cloud Desktop opens an **"Install a non-marketplace
   plugin"** dialog — click **Install**.
3. On Windows you may be prompted for your account credentials as part of
   installing the addon (it needs filesystem access to read your media) — that is
   a normal elevation prompt, not a malware warning.
4. Open (or restart) Premiere Pro and find the panel under
   **Window → UXP Plugins → Unphased**.

No Developer Mode toggle and no manual signing are needed — independent `.ccx`
distribution just works, as long as `manifest.json`'s `host` field is a single
object. An array there is the UXP-devtools dev-loop format, and using it in a
packaged build causes a generic, hard-to-diagnose "Couldn't install plugin"
failure.

## Versioning & packaging

- `node scripts/set-version.js 0.3.0 --with-cep` — updates the manifest,
  package.json, the panel footer, the version `ping()` reports, and the CEP
  manifest and `VERSION` file, so the two plugins stay in step.
- `npm run build` — stages the runtime files only and zips them (forward-slash
  entries) into `dist/Unphased-UXP-<version>.ccx`, failing if the engine has
  drifted, if no native addon is present, or if the package is suspiciously large.

## Licensing

Bundling FFmpeg means complying with the **LGPL v2.1+**: the addon links an
LGPL-configured FFmpeg 8.1.2 (`--disable-everything` plus audio-only components),
no GPL components enabled. Source: <https://ffmpeg.org>. IBM Plex fonts are under
the OFL (`fonts/LICENSE.txt`). See [`native/README.md`](native/README.md) for how
the addon is built.
