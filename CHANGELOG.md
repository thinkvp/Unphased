# Changelog

All notable changes to Unphased are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Both plugins ship off one tag and always carry the same version number: the UXP
version lives in `uxp/manifest.json`, the CEP version in `cep/VERSION`, and CI
fails the build if they disagree.

## [Unreleased]

## [1.0.0]

First public release. The tree carried an internal 0.2.0 that was never tagged
or published, so everything below is what 1.0.0 ships.

### The plugins

- **UXP plugin** for Premiere Pro 26+ — self-contained, with a statically
  linked audio-only FFmpeg 8.1.2 decode addon. No Node install, no ffmpeg on
  PATH, no scratch files: decode and DSP both run in the panel. One `.ccx`
  carries **Windows x64 and universal macOS (Apple Silicon + Intel)** addons.
- **CEP extension** for Premiere Pro 2024/2025 on Windows — the same DSP run in
  system Node via `engine/cli.js`, decoding through a system ffmpeg. Ships as a
  **double-click installer** (`Unphased-CEP-Setup-<version>.exe`) that needs no
  admin rights, sets `PlayerDebugMode` across CSXS 9–14, and bundles the engine
  inside the extension folder so the panel is self-contained. Installing over an
  existing development junction removes the link first rather than writing
  through it into the checkout.

### The engine

- **Shared DSP** (`engine/`, zero dependencies): GCC-PHAT coarse alignment with
  coherence-weighted band selection, a Viterbi drift lattice for time-varying
  delay, polarity detection, Kaiser-sinc fractional-delay rendering, and static
  or time-varying spectral phase correction. Null depth in dB is reported per
  clip.
- Peak picking by magnitude rather than maximum, so a polarity-inverted target
  does not lock onto an adjacent sidelobe — worth ~9.5 dB of null depth on real
  footage.
- Adaptive silence gate placed relative to the reference's own level rather than
  a fixed dBFS threshold, so conservatively recorded material is not rejected
  outright.
- Channel count, sample rate and bit depth preserved on render; analysis runs on
  a 48 kHz mono signal.

### The panel

- Selection-driven: click a track to mark it **REF**, select the clips you want
  aligned, press **Align**. No scan step and no scope toggle to leave on the
  wrong setting.
- Source-channel probing with a per-track override, for multi-input cameras that
  write one mono stream per mic across consecutive Premiere tracks. Pairs whose
  reference and target resolve to the same file, time *and* channel are refused
  rather than producing a perfect-looking, meaningless result.
- Segment-by-segment alignment when a target clip spans several reference clips,
  with originals muted only where aligned audio replaces them end to end.

### Verification

- 120 tests across two suites (89 engine, 31 UXP), including an end-to-end run
  against fixtures with known ground truth.
- Four CI workflows: the DSP on Linux with ffmpeg present, the UXP plugin and
  packaging on Windows, the CEP staging and installer build on Windows, and the
  native decoder on macOS. The test jobs fail on a non-zero skip count, so a
  skipped test cannot pass for a green one.

### Known limitations

- **The macOS build is a beta.** CI verifies the addon builds universal and
  decodes bit-exactly, but the panel has never been run in Premiere on a Mac.
- The UXP host layer (`uxp/js/premiere.js`) has not yet been exercised against a
  live Premiere 26 session on any platform.
- The UXP panel blocks Premiere's UI in short bursts, since there is no child
  process to offload the DSP to. Cancel takes effect after the segment in flight.
- The CEP extension is Windows-only and needs system Node ≥ 18 plus an ffmpeg
  install.

### Fixed before release

- **The macOS addon was never actually universal.** `build-ffmpeg-mac.sh` lipo'd
  the FFmpeg static libs for both architectures, but `native/CMakeLists.txt`
  never set `CMAKE_OSX_ARCHITECTURES`, so the addon linking them was built for
  the host architecture alone — and `native/README.md` then instructed you to
  copy that single-slice binary into both `mac/x64/` and `mac/arm64/`. It would
  have failed to load on the other architecture with only a generic "addon is
  not supported". Both build paths now verify with `lipo -archs`.
- The FFmpeg libs and the addon now pin the same macOS deployment target (11.0),
  so the libs cannot be built for a newer floor than the addon that links them.
- The engine suite's ffmpeg-dependent tests — seven of them, including every
  job-protocol end-to-end — were skipping silently in CI because they look for
  `UNPHASED_FFMPEG` or a Windows install path.
- `engine/test/panel.test.js` resolved bundled font paths with hardcoded
  backslashes, so it only passed on Windows.

[Unreleased]: https://github.com/thinkvp/Unphased/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/thinkvp/Unphased/releases/tag/v1.0.0
