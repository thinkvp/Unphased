# Changelog

All notable changes to Unphased are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Both plugins ship off one tag and always carry the same version number: the UXP
version lives in `uxp/manifest.json`, the CEP version in `cep/VERSION`, and CI
fails the build if they disagree.

## [Unreleased]

### Changed

- Documentation brought in line with the selection-driven panel: the README's
  usage steps no longer describe a Scan button, automatic targeting of every
  track, or a whole-sequence / selected-clips scope toggle.
- Removed the "Why only selected clips" block from both panels' in-app
  instructions.

### Added

- `CONTRIBUTING.md`, this changelog, GitHub issue and pull-request templates.
- CI workflows for the engine and the UXP plugin, and a tag-driven release
  workflow that builds the `.ccx` and the CEP bundle.

## [0.2.0]

This changelog starts at 0.2.0, the first version tracked in git. The state it
describes:

### Added

- **UXP plugin** for Premiere Pro 26+ (Windows x64) — self-contained, with a
  statically linked audio-only FFmpeg 8.1.2 decode addon
  (`uxp/win/x64/unphased.uxpaddon`). No Node install, no ffmpeg on PATH, no
  scratch files: decode and DSP both run in the panel.
- **CEP extension** for Premiere Pro 2024/2025 (Windows) — the same DSP run in
  system Node via `engine/cli.js`, decoding through a system ffmpeg.
- **Shared DSP engine** (`engine/`, zero dependencies): GCC-PHAT coarse
  alignment with coherence-weighted band selection, a Viterbi drift lattice for
  time-varying delay, polarity detection, Kaiser-sinc fractional-delay
  rendering, and static or time-varying spectral phase correction. Null depth in
  dB is reported per clip.
- Source-channel probing and per-track override, for multi-input cameras that
  write one mono stream per mic across consecutive Premiere tracks. Pairs whose
  reference and target resolve to the same file, time *and* channel are refused.
- Segment-by-segment alignment when a target clip spans several reference clips,
  with originals muted only where aligned audio replaces them end to end.
- Channel count, sample rate and bit depth preserved on render; analysis runs on
  a 48 kHz mono signal.
- Generated test fixtures with known ground truth (`testmedia/`) and 120 tests
  across the two suites.

### Known limitations

- Windows only. macOS build files exist for the native addon but are not built
  or tested.
- The UXP host layer (`uxp/js/premiere.js`) has not yet been exercised against a
  live Premiere 26 session.
- The UXP panel blocks Premiere's UI in short bursts, since there is no child
  process to offload the DSP to.

[Unreleased]: https://github.com/thinkvp/Unphased/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/thinkvp/Unphased/releases/tag/v0.2.0
