# Architecture

Unphased ships two plugins over one engine. The DSP, the job schema and the
clip-pairing logic are identical; only the host bridge and the decoder differ.

## CEP (Premiere 24/25)

```
┌────────────────────────── Premiere Pro ──────────────────────────┐
│  ┌──────────── CEP panel (cep/) ──────────────┐                  │
│  │ index.html + main.js   UI, orchestration   │   ExtendScript   │
│  │ pairing.js             clip-pair matching  │  ┌────────────┐  │
│  │ bridge.js         JSON over evalScript ────┼──► host.jsx   │  │
│  │ jobRunner.js      spawn system node ──┐    │  │ enumerate  │  │
│  └───────────────────────────────────────┼────┘  │ import     │  │
└──────────────────────────────────────────┼───────│ place/mute │──┘
                                           ▼       └────────────┘
                      ┌── system Node (engine/) ──┐
                      │ cli.js  run job.json      │──► NDJSON events
                      │ decode.js ── ffmpeg ──► 48k f32 WAV segments
                      │ align.js pipeline:        │
                      │  coarse → lattice→viterbi │
                      │  → polarity → sinc render │
                      │  → phase align → null dB  │
                      └───────────► aligned WAVs ─┘
```

## UXP (Premiere 26+)

UXP has no `child_process`, so there is no system Node to spawn and no ffmpeg to
shell out to. Everything collapses into the panel, and the decoder becomes a
bundled native addon.

```
┌────────────────────────── Premiere Pro ──────────────────────────┐
│  ┌──────────────────── UXP panel (uxp/) ───────────────────────┐ │
│  │ index.html + main.js   UI, orchestration                    │ │
│  │ pairing.js             clip-pair matching (shared verbatim) │ │
│  │ premiere.js ── require("premierepro") ──► UXP DOM ──────────┼─┼─► enumerate
│  │                    lockedAccess + executeTransaction        │ │   import
│  │ runner.js     job → per-pair pipeline → callbacks           │ │   place/mute
│  │   │                                                         │ │
│  │   ├─ js/engine/*.js   the SAME DSP, transpiled to CommonJS  │ │
│  │   └─ audio.js ──► unphased.uxpaddon (static LGPL FFmpeg)    │ │
│  │         probe()  → stream/channel layout                    │ │
│  │         decode() → float32 mono, exact window               │ │
│  └────────────────────────────┬────────────────────────────────┘ │
└───────────────────────────────┼──────────────────────────────────┘
                                ▼
                   aligned WAVs via UXP fs
```

Sharing is mechanical, not by convention: `uxp/scripts/build-engine.js` rewrites
`engine/src/*.js` from ES modules to CommonJS into `uxp/js/engine/`, and copies
`cep/js/pairing.js` to `uxp/js/pairing.js`. The generated files are committed so
the plugin folder loads as-is; `npm run lint` in `uxp/` regenerates them and
fails if they have drifted from the source `node --test` actually verifies.

Three engine modules are deliberately **not** shared: `decode.js` (spawns
ffmpeg), `progress.js` (writes NDJSON to stdout) and `wavFile.js` (`node:fs`).
Their UXP counterparts are `audio.js`, the runner's event callbacks, and UXP's
own `fs`. `wav.js` and `job.js` were made free of Node imports so they could be
shared unchanged.

## Data flow

Both plugins follow the same five steps; the CEP call is named first, the UXP one
after the slash.

1. **Enumerate** — `AA_getSequenceInfo` / `premiere.getSequenceInfo()` returns
   tracks/clips with media paths, timeline start (seconds + ticks), source
   in/out, speed. Pure data; no mutations.
2. **Pair** — `pairing.js` intersects each target clip with reference-track clips on the
   timeline, maps overlap to source-media seconds (`sourceIn = inPoint + (overlapStart −
   clipStart)`), skips unusable clips with warnings.
3. **Job** — the panel builds a job (see `engine/src/job.js` for the schema) and
   either writes `job.json` and spawns `system node engine/cli.js run job.json`,
   or hands the object straight to `runner.runJob()`.
4. **Engine** — per pair: extract ref (exact overlap) and target (overlap +
   handles), align, render a WAV that spans *exactly* the overlap interval. Because the
   shift is baked into the file, placement needs no sub-frame precision.
   CEP extracts by writing ffmpeg's output to scratch WAVs; UXP decodes straight
   into memory through the addon, **one channel at a time** at the source's
   native rate, so a long multichannel render never has to fit whole in a heap
   shared with Premiere.
5. **Reintegrate** — `AA_importAndPlace` / `premiere.importAndPlace()` imports to
   the "Unphased" bin, overwrites onto per-source new tracks at the original
   start, and disables the originals.

## DSP pipeline (engine/src/align.js)

| stage | module | notes |
|---|---|---|
| coarse offset | `coarse.js` | 1 s GCC-PHAT blocks, confidence-gated weighted median; rejects uncorrelated pairs via lag-agreement test |
| search window | `align.js` | `maxShiftMs: 'auto'` walks 250 → 500 → 1000 → 2000 ms, widening only when the winner sits past 85% of the window (a peak clipped by the window edge); job handles are sized for the ceiling so a widened pass has real audio to read |
| band weights | `coherence.js` | magnitude-squared coherence per band at the coarse lag; the static estimate is then re-run weighted |
| drift lattice | `lattice.js` | 8192-sample Hann windows, hop 4096, ±15 ms residual search, coherence-weighted |
| path solve | `pathSolver.js` | Viterbi: slope-limited (`driftAgility`, engine-only — the panel no longer exposes it), quadratic penalty, silent rows coast; parabolic sub-sample refine; linear interp + box smoothing to per-sample curve |
| polarity | `polarity.js` | plain NCC sign at solved lag (PHAT loses sign), RMS-weighted |
| render | `varyDelay.js` | 32-tap Kaiser sinc polyphase, time-varying fractional delay |
| phase | `phaseAlign.js` | block-wise STFT cross-spectrum, coherence-gated, complex-smoothed rotation interpolated over time, Hann OLA |
| metric | `align.js` | null depth dB with clamped non-negative gain — reported per clip |

### Coherence weighting

Plain PHAT whitens every bin to unit magnitude, so a bin of independent noise
votes as loudly as a bin of shared speech. `coherence.js` measures how much each
band the two mics genuinely share and weights the correlation accordingly, which
matters when the mics differ in noise character (wireless HF hiss, handling
rumble, HVAC). Weights sit on a canonical 512-bin DC..Nyquist grid so they are
independent of whatever FFT size `gccPhat` picks, and never reach zero — a fully
silenced band biases the peak.

### Adaptive silence gate

Gates are **relative to the material**, not a fixed dBFS value: `adaptiveGateDb`
places the threshold 25 dB below the reference's own average level, bounded to
[-85, -35] dBFS. The previous fixed -50 dBFS gate rejected conservatively
recorded material outright — every window gated, pair failed as "no
correlation". Used by coarse, lattice, polarity, phase and coherence alike.

### Multichannel and rate preservation

Analysis always runs on a 48 kHz mono signal (bounded cost, good for
correlation). Rendering re-extracts the target at its **native** rate with all
channels kept, and `align.renderChannel` replays the measured correction —
delay curve rescaled to the render timebase, polarity, then the phase rotation —
onto each channel. A stereo clip stays stereo; a 96 kHz clip stays 96 kHz. Output
bit depth follows the source unless `outputFormat` overrides it.

Key correlation detail: GCC-PHAT whitening is **band-limited** — bins whose cross-spectrum
magnitude is < 3e-6 of the max are zeroed. Without this, out-of-band numerical noise gets
inflated to full weight and can dominate the correlation (see gccPhat.js).

**Peak picking is by magnitude, not maximum.** A polarity-inverted target correlates
strongly *negatively* at the true lag; picking the maximum locks onto an adjacent sidelobe
and biases the delay by ~half a period of the dominant frequency. `gccPhat` returns the
extremum by `|value|` plus its `sign`, `lattice.js` folds that sign in before clamping, and
`align.js` resolves polarity *before* drift tracking and rendering so every later stage sees
a correctly-signed signal. On real footage this was worth ~9.5 dB of null depth.

The `nullDepthDb` gain term is clamped non-negative on purpose: an unclamped least-squares
gain goes negative for an inverted signal and reports a deep null for audio that would
*cancel* the reference when summed — the exact fault the metric exists to catch.

Lag convention everywhere: positive lag = target LAGS reference by that many samples.

## Source channel resolution (important)

Premiere exposes **nothing** about which audio stream or channel a timeline clip
uses — verified by probing `projectItem` and `trackItem` in ExtendScript on PPro
2025, and unchanged in the UXP DOM. A multi-input camera writes one mono stream
per mic and Premiere spreads them across consecutive tracks, so several tracks
share a media path and differ only by stream index.

Mitigation is three-part:
1. `cli.js probe` (ffprobe) / `audio.probeStreams` (the addon) reports each
   file's stream/channel layout. Both return the same shape.
2. `pairing.defaultSourceMap` assigns streams by track order among tracks sharing a file
   (matching Premiere's layout), with a per-track override in the panel.
3. `pairing.buildPairs` **refuses** any pair whose ref and target resolve to the same file,
   source time and channel — that combination decodes identical audio and yields a
   flawless-looking, entirely meaningless result (0.0 ms delay, no drift, ~50 dB null).

`decode.js` selects a stream with `-map 0:a:N` and a channel within an interleaved stream
with `pan=mono|c0=cN`; it only downmixes when no channel is specified. The native
addon reproduces both: an ordinal lookup among audio streams, and a 1×N
swresample rematrix that picks one channel (`channel: -1` downmixes).

## Job protocol

The same events either way, so the panel logic is identical. CEP: engine stdin
none, stdout NDJSON. UXP: `runner.runJob(job, onEvent)` calls back with the same
objects.

`start`, `phase` (extract/align/write + pct), `result` (status, staticDelayMs,
driftRangeMs, polarityInverted, phaseApplied, confidence, nullDepthDb,
outputPath), `error`, `done`. The CLI's exit code adds nothing the events don't:
0 = all ok, 2 = some pairs failed, 1 = fatal.

`normalizeJob` is shared and pure. `tempDir` is optional and unused by UXP, which
never writes a scratch file — creating it is the caller's job (`cli.js` does it).

## Native decode addon (UXP)

`unphased.uxpaddon` is a statically linked, audio-only FFmpeg 8.1.2 exposing two
functions; see `uxp/native/README.md`. The one place it does more than Syncitol's
equivalent is **sample-accurate window trimming**: a decoder handed a start time
returns the whole frame containing it — up to ~23 ms early for AAC — and that
error would land straight in the measured delay. `decodeMono` seeks backward of
the window and trims the first accepted frame to the exact input sample, which is
what putting `-ss` *after* `-i` bought the CEP build. `uxp/tests/decodeCore.test.js`
asserts a bit-exact match against a known WAV, and that neighbouring lags fit
visibly worse.

## Premiere API notes

### CEP / ExtendScript

- Ticks: 254016000000 per second. Clip `start.ticks` is passed through as a string.
- `overwriteClip(projectItem, startSeconds)` — seconds as float; placement error at
  double precision is ≪ 1 sample.
- QE `addTracks` is undocumented; `AA_ensureTracks` tries two signatures, verifies the
  track count actually grew, and otherwise asks the user to add tracks manually.
- ExtendScript is ES3: no JSON (json2.jsx shipped), no const/let/arrows in host.jsx.

### UXP

- `SequenceEditor.createOverwriteItemAction(projectItem, TickTime, videoTrackIndex,
  audioTrackIndex)` **creates the track** when the index exceeds the track count.
  There is no add-track API in UXP and none is needed — the QE dance above has no
  counterpart here.
- No `nodeId` on track items. Clips are addressed by `(trackIndex, clipIndex)`,
  with the start tick as a sanity check, and re-fetched fresh inside each
  transaction rather than held across an await.
- Scanning is two-pass: timing first, media paths second. `getMediaFilePath()`
  yields to the host and invalidates transient `TickTime`/trackItem handles.
- Selection: `trackItem.getIsSelected()` per clip. `Sequence.getSelection()`
  returns a selection group with no positional mapping back to tracks — the
  reverse of CEP, where per-clip `isSelected()` was the unreliable one.
- Edits must be built synchronously inside
  `lockedAccess(() => executeTransaction(cb, label))`; an await in the builder
  lets the host mutate underneath and objects go "no longer valid".
- Placement and muting run as two transactions, so a failed placement cannot roll
  back mutes that did land.
