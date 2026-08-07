# Unphased

[![Engine CI](https://github.com/thinkvp/Unphased/actions/workflows/engine-ci.yml/badge.svg)](https://github.com/thinkvp/Unphased/actions/workflows/engine-ci.yml)
[![UXP CI](https://github.com/thinkvp/Unphased/actions/workflows/uxp-ci.yml/badge.svg)](https://github.com/thinkvp/Unphased/actions/workflows/uxp-ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An Auto Align Post-style audio alignment plugin for Adobe Premiere Pro: align lav
mics (and any other mics) to a reference track (boom) with **dynamic time-varying
delay correction**, **automatic polarity fixing**, and **spectral phase
correction**, then place rendered, aligned audio back into the timeline
non-destructively.

<img src="docs/unphased-uxp-screenshot.png" alt="The Unphased UXP panel in Premiere Pro: a five-track sequence with Audio 3 marked REF, clips selected on Audio 4 and 5, and the Time and Phase controls above the track list." width="420">

*The UXP panel. Audio 3 is the reference; the two tracks with selected clips
become targets automatically, and the line under the list says exactly what
Align will do.*

## Which version do I need?

Unphased ships as two plugins, built for different Premiere generations:

| | [`uxp/`](uxp/) — UXP plugin | [`cep/`](cep/) — CEP extension |
|---|---|---|
| **Premiere Pro** | 26.0+ | 24, 25, 26+ |
| **OS** | Windows, macOS † | Windows |
| **ffmpeg** | Bundled — no install needed | System install needed |
| **Node.js** | Not needed | System Node 18+ needed |
| **Install** | Download `.ccx`, double-click | Download `Setup.exe`, double-click |

- **On Premiere 26+:** use the **UXP** version. It is self-contained — no Node,
  no ffmpeg, no PATH setup — and it is where Adobe's extensibility platform is
  headed.
- **On an older Premiere (24/25):** use the **CEP** version. UXP hybrid plugins
  (the kind Unphased needs for its bundled FFmpeg decoder) require Premiere 26+.

† **macOS is built and tested, but not yet confirmed in Premiere.** The `.ccx`
carries a universal (Apple Silicon + Intel) decode addon, and CI builds it from
source and verifies it decodes bit-exactly against the test fixtures on every
change. What no automated check can cover is the panel actually running in
Premiere on a Mac — nobody has done that yet. Treat the macOS build as a beta
and report what you find.

Both run the **same DSP engine** and produce the same numbers; they differ only
in how they reach the host and how they decode audio.

Both install from the [Releases page](https://github.com/thinkvp/Unphased/releases)
with a double-click and no admin rights. See [`uxp/README.md`](uxp/README.md) or
[`cep/README.md`](cep/README.md) for the steps and the differences that are
visible in use.

## Layout

```
engine/     standalone Node.js DSP engine (zero dependencies) — the shared brain
cep/        CEP extension for Premiere 24/25 (UI + ExtendScript host layer)
uxp/        UXP plugin for Premiere 26+ (UI + UXP host layer + native decoder)
docs/       architecture notes
testmedia/  generated test fixtures with known ground truth
.github/    CI workflows, issue and PR templates
```

`engine/` is the single source of truth for the alignment maths. The CEP panel
runs it in system Node; the UXP plugin runs a CommonJS transpile of the same
files in-panel (`uxp/scripts/build-engine.js`, with `npm run lint` failing on
drift). `cep/js/pairing.js` — the clip-pair matcher — is shared the same way.

## Usage

1. Open a sequence. The panel reads it and probes each media file's audio layout
   automatically — there is no Scan step.
2. Click one track to mark it **REF** (the boom, or whichever mic is the
   yardstick).
3. **Select the clips you want aligned** in the timeline. Any other track with a
   selected clip becomes a target, live, as you click around — the badge beside
   each track shows its current selected count. Select everything on a track to
   process the whole thing.
4. If the log flags multiple mics per file, press **Sources** and check the
   source-channel assignment. The pickers are hidden otherwise.
5. Options, two of them: **Time** (Dynamic tracks drift, Static applies one
   offset) and **Phase** (Spectral tracks a changing phase relationship, Static
   fits one curve to the whole clip, Off leaves the target's own character
   alone).
6. Press **Align**. Per clip, the engine extracts the overlapping audio, aligns
   it, and renders a new WAV. The panel imports the results into an **Unphased**
   bin, places them on new tracks at the exact original positions, and disables
   the originals.

The reference track is never filtered by selection — it is the yardstick, and
supplies material wherever it overlaps a target. **Refresh** (next to Sources)
re-reads the sequence; you only need it after adding a track, adding clips, or
swapping media without switching sequences, since Align re-reads for itself
first.

Failed pairs (no correlation, too little overlap, offline media, speed-changed
clips) are skipped with a warning; nothing in your timeline is modified for those.

A target clip spanning several reference clips is aligned **segment by segment**,
one rendered file per reference clip, each placed at its own position. Originals
are muted **only when the aligned segments replace them end to end** — a
partially covered clip stays audible so no silent gap is created.

Stereo and multichannel clips keep their channel count, sample rate and bit
depth: the analysis runs on a 48 kHz mono signal, but the correction is applied
to every channel at the source's own rate.

### Source channels — read this if you use camera audio

Premiere's scripting API does **not** expose which audio channel or stream a
timeline clip is using — in either CEP or UXP. A multi-input camera (Sony FX6
etc.) writes one mono stream per mic and Premiere lays them across consecutive
audio tracks, so several tracks share one media path and differ only by stream.

The panel probes each media file as it reads the sequence, and offers a
**source picker** on any
track whose file gives a choice (`src 1`, `src 2` … for multi-stream files;
`left`, `right`, `stereo` for interleaved stereo). The default assigns streams by
track order among tracks sharing a file, which matches how Premiere lays them
out.

The pickers are hidden by default — for ordinary single-mic files there is
nothing to decide. The **Sources** button above the track list shows them, and
only appears when some track's media actually offers a choice. When the
assignment is a real guess the log says so: **open Sources and verify
before aligning** — if two tracks point at the same stream, you are aligning a
signal with itself.

That case is caught: pairs whose reference and target resolve to the same file,
time *and* channel are refused with a warning rather than producing a meaningless
result.

### Where the rendered files go

The aligned WAVs are project media — Premiere references them for as long as the
project exists — so they are written to an **`Unphased Audio`** folder beside the
`.prproj`, and each run stamps its filenames with the date and time so
re-aligning never overwrites audio a clip already points at. Old runs can be
deleted once you are happy with the current one.

Override the location with **rendered audio folder** in Settings
(`unphased.renderDir`). On a project that has never been saved there is nowhere
to put them, so they fall back to a scratch folder and the log says so — save the
project and align again to keep them.

### Reading the results

`Null` is the headline number: how deeply the aligned clip cancels against the
reference. Interpret it in context — it is not "higher is always better proof of
success":

- **> 40 dB** — suspiciously perfect. Almost always means both sides decoded the
  *same* audio. Check the source assignment.
- **10–25 dB** — a genuinely good alignment of two different mics on the same source.
- **3–10 dB** — normal for mics in very different positions (lav vs
  camera-mounted). The timing is corrected; the acoustics still differ, and no
  tool can null that away.
- **< 2 dB with `Pol ok`** — little real correlation; treat the result with suspicion.

A `Delay` of exactly ±0.0 ms with `Drift —` and a huge null is the signature of a
clip aligned against itself.

## Verifying with the test project

1. `node engine/cli.js gen-fixtures testmedia` (already generated).
2. New Premiere project → import `testmedia/boom.wav`, `lav1.wav`, `lav2.wav`.
3. Drop boom on A1, lav1 on A2, lav2 on A3 — all starting at 00:00.
4. Panel: click A1 to make it **REF**. Select the lav1 and lav2 clips in the
   timeline, leave Time on Dynamic → **Align**.
5. Expected (see `testmedia/ground-truth.json`):
   - lav1: delay ~ +18 ms with ~3 ms drift span, polarity **inv**, deep null.
   - lav2: delay ~ +7.3 ms, phase correction applied, deep null.
6. A/B: the originals are disabled; apply Invert on the boom clip and play an
   aligned track — it should nearly cancel.

## Tests

```bash
cd engine && npm test                # 89 tests — the shared DSP
cd uxp && npm run lint && npm test   # 31 tests — the UXP plugin
```

Both suites are pure Node with no dependencies to install. CI runs them on every
push and pull request — see [`.github/workflows/`](.github/workflows/).

The engine suite covers WAV I/O, FFT, GCC-PHAT, static + dynamic alignment
against synthetic and real-resampler drift, polarity, static and time-varying
phase correction, coherence band weighting, quiet-recording robustness,
stereo/96 kHz preservation, the job protocol CLI (with ffmpeg), the pairing and
channel-mapping logic, and static consistency of the CEP panel itself. Tests
needing ffmpeg skip themselves when it is absent.

The UXP suite covers the generated CommonJS engine (exports and numbers matching
the ESM source), the decode/padding layer, an end-to-end run against
`testmedia/`, the panel's static wiring, and — when the native harness has been
built — the decode core's sample-accuracy and channel selection.

## Contributing

Bug reports and pull requests are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md)
for the layout rules that matter (the engine is the single source of truth, the
UXP copies are generated) and what CI checks. Release history is in
[`CHANGELOG.md`](CHANGELOG.md).

## License

[MIT](LICENSE) for Unphased's own code. Bundled third-party components (IBM Plex
fonts, FFmpeg) keep their own licenses — see [`LICENSE`](LICENSE).
