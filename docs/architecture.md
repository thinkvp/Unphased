# Architecture

Unphased is one Premiere plugin over one standalone engine. The DSP lives in
`engine/` as plain Node ES modules that `node --test` runs directly; the plugin
runs a CommonJS transpile of those same files inside the panel.

## The plugin (Premiere 26+)

UXP has no `child_process`, so there is no system Node to spawn and no ffmpeg to
shell out to. Everything runs in the panel, and the decoder is a bundled native
addon.

```
┌────────────────────────── Premiere Pro ──────────────────────────┐
│  ┌────────────────────── panel (uxp/) ─────────────────────────┐ │
│  │ index.html + main.js   UI, orchestration                    │ │
│  │ pairing.js             clip-pair matching                   │ │
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
`engine/src/*.js` from ES modules to CommonJS into `uxp/js/engine/`. The
generated files are committed so the plugin folder loads as-is; `npm run lint`
in `uxp/` regenerates them and fails if they have drifted from the source
`node --test` actually verifies.

Two panel modules run the other way round. `uxp/js/pairing.js` (clip-pair
matching) and `uxp/js/volume.js` (Premiere's Level scale) are hand-maintained
UMD files that the *engine* test suite requires directly, so they are unit-tested
without a host even though they live in the plugin tree.

Three engine modules are deliberately **not** carried into the panel:
`decode.js` (spawns ffmpeg), `progress.js` (writes NDJSON to stdout) and
`wavFile.js` (`node:fs`). Their in-panel counterparts are `audio.js`, the
runner's event callbacks, and UXP's own `fs`. `wav.js` and `job.js` were made
free of Node imports so they could be used unchanged on both sides.

## Data flow

Five steps, whether driven from the panel or from `engine/cli.js`.

1. **Enumerate** — `premiere.getSequenceInfo()` returns
   tracks/clips with media paths, timeline start (seconds + ticks), source
   in/out, speed. Pure data; no mutations.
2. **Pair** — `pairing.js` intersects each target clip with reference-track clips on the
   timeline, maps overlap to source-media seconds (`sourceIn = inPoint + (overlapStart −
   clipStart)`), skips unusable clips with warnings.
3. **Job** — the panel builds a job (see `engine/src/job.js` for the schema) and
   hands the object straight to `runner.runJob()`. Headless, the same object is
   written as `job.json` and passed to `node engine/cli.js run job.json`.
4. **Engine** — per pair: extract ref (exact overlap) and target (overlap +
   handles), align, render a WAV that spans *exactly* the overlap interval. Because the
   shift is baked into the file, placement needs no sub-frame precision.
   The CLI extracts by writing ffmpeg's output to scratch WAVs; the panel decodes
   straight into memory through the addon, **one channel at a time** at the
   source's native rate, so a long multichannel render never has to fit whole in
   a heap shared with Premiere.
5. **Reintegrate** — `premiere.importAndPlace()` imports to
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
uses — probed directly on `projectItem` and `trackItem`, and absent from the UXP
DOM as well as from the older scripting API. A multi-input camera writes one mono stream
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

The same events either way, so the consuming logic is identical. Headless,
`engine/cli.js` writes NDJSON to stdout. In the panel, `runner.runJob(job,
onEvent)` calls back with the same objects.

`start`, `phase` (extract/align/write + pct), `result` (status, staticDelayMs,
driftRangeMs, polarityInverted, phaseApplied, confidence, nullDepthDb,
outputPath), `error`, `done`. The CLI's exit code adds nothing the events don't:
0 = all ok, 2 = some pairs failed, 1 = fatal.

`normalizeJob` is shared and pure. `tempDir` is optional and unused by UXP, which
never writes a scratch file — creating it is the caller's job (`cli.js` does it).

Auto-mix uses a deliberately different job shape — `mics`, not `pairs`, validated
by `normalizeAutoMixJob` — so a job file is unambiguously one kind or the other.
Its events reuse the same vocabulary, plus `start` carrying `mode: 'automix'` and
one `automix` summary event with per-pair geometry (`spreadMs` is the first
number to check on real material) and per-mic behaviour. In curve mode the
per-mic `result` carries `keys`/`maxErrorDb` instead of `outputPath`.

## Auto-mix (engine/src/autoMix.js)

A second, independent operation over the same engine: given N mics that are
**equal participants**, decide per frame whose mic the current speaker is on and
duck the rest. No reference, no targets — that asymmetry belongs to align.js and
must not leak in, because the driving case is three lavs on three people where
every mic is someone's close mic and everyone else's bleed.

Driven from the panel and from `node engine/cli.js automix <job.json>`.

### Why three tiers

On separate recorders the lag between two mics is

```
measuredLag_ij(t) = clockOffset_ij + drift_ij*t + acousticTDOA_ij(t)
                    \__ seconds __/  \__ ms __/   \__ +/-3 ms/m __/
                                                   the entire signal
```

The lead/lag sign carries nothing until the first two terms are removed. The
obvious reuse is a trap: `buildLattice` + `solvePath` at `maxDriftMs: 15` would
absorb the acoustic swing **as drift**, because the Viterbi slope penalty exists
to make a lag series smooth and the non-smooth part is what we want.

| tier | purpose | window / hop @ 8 kHz | search |
|---|---|---|---|
| sync | static offset per pair (`pairSyncOffset`) | `estimateStaticOffset`, 24 blocks | ±2000 ms |
| baseline | affine clock model `a + b*t` (`fitPairBaseline`) | 2048 / 2048 | ±30 ms |
| attribute | per-frame acoustic TDOA (`attributeSpeakers`) | 512 / 128 (62.5 fps) | ±8 ms |

Attribution runs on audio decimated 48 k → 8 k. One sample is 0.125 ms ≈ 4.3 cm
against a ~3 ms/m discriminator, and it keeps K mics resident in 19 MB each
rather than 115 MB.

### Cues and scoring

`attributeSpeakers` returns cues, not a decision — level (`nLevelDb`, normalised
against each mic's own p95 so recorders trimmed differently compare), lead
(`lead`, summed over pairs and normalised by summed confidence), and
`coherence`. `autoMixGains` combines them, so an ablation on the scoring weights
does not re-run tens of thousands of correlations.

Three choices worth not undoing:

- **Winner-relative, not sum-relative.** Dugan's `level_i / Σ level_j` is for
  gain-before-feedback in live PA. In post it puts three equal mics 9.5 dB down
  during a pause, which is worse than no auto-mix. Scoring against the winner
  makes every degenerate case a no-op.
- **Activity is `levelActivity * coherence`.** `adaptiveGateDb` is relative to
  each mic's own level, so room tone sits *above* every mic's gate — a level-only
  activity test ducks silence. Nothing localisable means nothing to attribute.
- **Never mutes** (`maxDuckDb`). Deeper pumps room tone, and it would destroy the
  material for the per-band stage that comes later.

### Levels (`levelMatch`)

Ducking decides *who*; this decides *how loud*. Without it a mic set 16 dB hot is
still 16 dB hot in the output whenever its owner talks. The correction is a
constant per mic, deliberately **not** folded into the duck curve — a "duck
depth" measured off a combined curve would include a level correction that is not
a duck. Consumers add the two where a constant offset is what it is.

| mode | aims at | needs |
|---|---|---|
| `target` (default) | `targetLufs`, absolute, default −16 | `speechLufs` |
| `match` | median of the other mics' speaking levels | `refDb` |
| `off` | nothing | — |

Both work off a measurement of **one person's own dialogue**, which is what
attribution bought: the frames where timing says that mic's wearer was the source.
That gate is the whole point. A track's own integrated loudness counts bleed and
room tone as programme, so the quietest participant — whose mic spends most of the
take catching everyone else — reads *loud* and would be turned **down**.

`speechLufs` is ITU-R BS.1770 (`engine/src/loudness.js`), K-weighted with
coefficients re-derived per sample rate rather than tabulated, since attribution
runs at 8 kHz and the published biquads are 48 kHz only. It is not derivable from
`refDb`: that is a p95 of frame RMS, a peak-ish statistic with no fixed
relationship to a mean-square loudness.

Three bounds, all reported rather than silently absorbed (`matchClamp`):

- **`headroom`** — upward gain is capped so the loudest frame plus
  `crestAllowanceDb` stays under full scale. Clipping a track is worse than
  leaving it quiet.
- **`range`** — `maxMatchDb` (18). Further than that from where it should be is
  more likely a bad estimate than a real trim.
- **`unmeasured`** — attribution never caught this mic leading, so everything
  above its gate is other people. Amplifying bleed is the worst thing a level
  control can do, and the mic is left alone. Such a mic is also kept out of
  `match`'s median.

Measured on the decimated copy, `speechLufs` reads ≈0.4 LU low (the anti-alias
filter takes the top of the speech band, and K-weighting lifts that band 4 dB), so
delivery lands slightly above the number asked for. Left uncorrected on purpose:
it is a bias of consistent sign and size, so it moves no mic relative to another,
and a constant fitted on fixtures would stop being right the moment `decimation`
changes. End to end, renders land within ~1.2 LU of target.

### Output modes

`output: 'curve' | 'render' | 'both'`, default `curve`. Auto-mix is the only
feature here that *can* be non-destructive: its output is a broadband gain curve,
which is what a volume automation track is. Alignment cannot be (sub-sample
resampling is not a timeline parameter) and per-band bleed reduction cannot be
(it is spectral).

`simplifyGainCurve` reduces 62.5 fps to a keyframe list by Douglas-Peucker with
an explicit dB bound — around 5 keys/second at the 0.25 dB default. Times are
clipped to the clip's own interval, since a host cannot key before a clip starts.
`applyGainCurve` is the render path: it mirrors `renderChannel`'s time-axis
resample and deliberately omits the value scaling, because a delay is in samples
and a gain is dimensionless. It is safe in place.

### Known limitations

- **`gccPhat` is not reentrant.** Its scratch cache is module-level and keyed by
  FFT size, so the per-pair correlations must run one at a time. `Promise.all`
  over pairs would corrupt results silently, with no crash. Real parallelism
  needs worker threads. `pool.js` does not apply — its model is independent
  pairs, and auto-mix's expensive stage is global.
- **Clock offsets are fitted pair by pair, and that breaks down for K ≥ 3.** The
  mid-range in `fitPairBaseline` assumes both members of a pair take turns being
  the nearest mic. When the source is nearest to *neither*, the true residual is
  0 — a third mode between them. A participant who never speaks therefore only
  ever produces `{+delta, 0}`, the baseline lands at `delta/2`, and their mic
  appears to lead during everyone else's turns; the cue nets to neutral and they
  are ducked ~3 dB instead of ~12 dB. Fixing it means estimating per-mic clock
  offsets **globally** across all pairs rather than pairwise. This is the top
  item for the next iteration.
- **Cost is O(K²) in mic count.** Candidate pruning bounds the per-frame pass but
  not sync/baseline, which still run once per unordered pair. `node bench.js
  automix 60` reports both; K=8 costs several times K=3.

## Native decode addon (UXP)

`unphased.uxpaddon` is a statically linked, audio-only FFmpeg 8.1.2 exposing two
functions; see `uxp/native/README.md`. The one place it does more than Syncitol's
equivalent is **sample-accurate window trimming**: a decoder handed a start time
returns the whole frame containing it — up to ~23 ms early for AAC — and that
error would land straight in the measured delay. `decodeMono` seeks backward of
the window and trims the first accepted frame to the exact input sample — the
same guarantee putting `-ss` *after* `-i` gives ffmpeg on the headless path.
`uxp/tests/decodeCore.test.js`
asserts a bit-exact match against a known WAV, and that neighbouring lags fit
visibly worse.

## Premiere API notes

Ticks: 254016000000 per second. Clip start times are carried as tick strings
alongside seconds, so placement never depends on float rounding.

- `SequenceEditor.createOverwriteItemAction(projectItem, TickTime, videoTrackIndex,
  audioTrackIndex)` **creates the track** when the index exceeds the track count.
  There is no add-track API in UXP and none is needed.
- No `nodeId` on track items. Clips are addressed by `(trackIndex, clipIndex)`,
  with the start tick as a sanity check, and re-fetched fresh inside each
  transaction rather than held across an await.
- Scanning is two-pass: timing first, media paths second. `getMediaFilePath()`
  yields to the host and invalidates transient `TickTime`/trackItem handles.
- Selection: `trackItem.getIsSelected()` per clip. `Sequence.getSelection()`
  returns a selection group with no positional mapping back to tracks, so it
  cannot be used to decide which track a selected clip belongs to.
- Edits must be built synchronously inside
  `lockedAccess(() => executeTransaction(cb, label))`; an await in the builder
  lets the host mutate underneath and objects go "no longer valid".
- Placement and muting run as two transactions, so a failed placement cannot roll
  back mutes that did land.
