# Unphased native addon (`unphased.uxpaddon`)

The UXP plugin has no `child_process`, so it cannot shell out to ffmpeg the way
`engine/src/decode.js` does on the headless path. This addon is the in-panel
replacement: a statically linked, audio-only FFmpeg 8.1.2 wrapped in a UXP
hybrid addon, exposing exactly the two operations decode.js gets from the
command line.

```
probe(path)
  -> { ok, error, durationSec,
       streams: [{ index, channels, sampleRate, bits, sampleFmt, codec }] }

decode(path, audioStream, channel, startSec, durationSec, sampleRate)
  -> { sampleRate, samples: ArrayBuffer }      // float32 mono, LE

decodeAsync(path, audioStream, channel, startSec, durationSec, sampleRate)
  -> Promise<{ sampleRate, samples: ArrayBuffer }>   // same, on a background pool

decodeThreads() -> pool size      cpuCount() -> logical CPU threads
```

`decode` runs on UXP's scripting thread. `decodeAsync` runs the same decode on
a pool of worker threads sized from the CPU — `clamp((cpus - 2) / 2, 1, 6)`, so
4 threads → 1, 8 → 3, 12 → 5, 16+ → 6 — and posts each result back to the
scripting thread with `uxp_addon_schedule_on_javascript_queue`. `Terminate`
stops results being posted before it joins the pool, so nothing reaches a torn
down panel, and `Init` re-arms it for a panel reload. How many decodes JS keeps
in flight is limited by a **memory budget** in `js/audio.js`, not just by the
pool size: Unphased decodes whole clip regions, and those live in Premiere's
heap until they are used.

`decodeMono` reads only the stream it decodes: every other stream is set to
`AVDISCARD_ALL`, so MP4/MOV skip the video samples outright and MXF steps over
them, and `avformat_find_stream_info` runs only when the header does not fully
describe that stream. On camera files over a network share that was most of
the time a decode took. `probeFile` still always probes; it runs once per file.

`channel` is `-1` to downmix the stream to mono or `0..n-1` to select one
channel (`pan=mono|c0=cN`); `sampleRate` is `0` to keep the stream's own rate.
`index`/`audioStream` are ordinals **among audio streams** — the `N` in
`-map 0:a:N`. The JS side of the contract lives in [`../js/audio.js`](../js/audio.js);
keep the two in step.

The one thing this core does that Syncitol's equivalent did not is **trim the
first decoded frame to the exact requested sample**. A decoder handed a start
time will return the whole frame containing it — up to ~23 ms early for AAC —
and that error would land straight in the measured delay. `decodeMono` seeks
backward of the window and trims — the same guarantee putting `-ss` *after* `-i`
gives ffmpeg on the headless path.

## Layout

```
src/unphased_decode.{h,cpp}   FFmpeg decode + probe core (no UXP types)
uxp/src/module_unphased.cpp   addon glue (UxpAddonShared.h C API)
uxp/src/api/, uxp/src/utilities/   Adobe's UXP addon SDK glue, unmodified
uxp/win/unphased.vcxproj      Windows x64 build
CMakeLists.txt                macOS build (used by CI)
```

## Building FFmpeg (Windows)

The addon needs static, audio-only FFmpeg libs under
`native/third_party/ffmpeg-static/{include,lib}`. Build them with the scripts in
`F:\ffbuild` (MSVC toolchain via msys2):

```bat
curl -L -o ffmpeg-8.1.2.tar.xz https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz
tar -xJf ffmpeg-8.1.2.tar.xz
build-static.bat
```

`build-static.sh` configures with `--disable-everything` plus only the audio
demuxers, decoders and parsers Unphased can encounter, which is what keeps the
addon around 2–3 MB and keeps the build **LGPL** (no GPL components). It
installs to `out-static`; copy `out-static/include` and `out-static/lib` into
`native/third_party/ffmpeg-static/`.

## Building the addon (Windows)

```bat
msbuild native\uxp\win\unphased.vcxproj /p:Configuration=Release /p:Platform=x64
copy native\uxp\win\build\unphased.uxpaddon uxp\win\x64\
```

`/MT` matters: it matches the CRT the static FFmpeg libs are built against and
leaves the addon with no VC++ redistributable dependency on the user's machine.

The Windows addon is **committed** to `uxp/win/x64/` — it is the artifact
`scripts/build-ccx.js` packages, and rebuilding FFmpeg on every CI run for a
file that changes twice a year is not worth the minutes.

## Verifying the decode core without Premiere

The addon itself only runs inside Premiere, but the part that can quietly poison
an alignment — window trimming and channel selection — is plain C++.
`tools/decode_smoke.cpp` is a CLI around it, and `uxp/tests/decodeCore.test.js`
drives that against the `testmedia/` fixtures (skipping itself when the harness
has not been built).

```bat
cd native
cl /nologo /std:c++17 /EHsc /MT /O2 /Fo:build\ ^
   /I third_party\ffmpeg-static\include /I src ^
   tools\decode_smoke.cpp src\unphased_decode.cpp ^
   /link /LIBPATH:third_party\ffmpeg-static\lib ^
   avformat.lib avcodec.lib swresample.lib avutil.lib ^
   Bcrypt.lib Mfplat.lib Mfuuid.lib Ole32.lib User32.lib Strmiids.lib ^
   Ws2_32.lib Secur32.lib /OUT:build\decode_smoke.exe
```

Run it from a Developer Command Prompt (or after `vcvars64.bat`).

## Building the addon (macOS)

Run from `uxp/`:

```bash
curl -fsSL -o ffmpeg.tar.xz https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz
tar xf ffmpeg.tar.xz
FFMPEG_SRC_DIR="$PWD/ffmpeg-8.1.2" PREFIX_BASE="$PWD/ffmpeg-out" \
  bash scripts/build-ffmpeg-mac.sh universal
cmake -S native -B native/build -DFFMPEG_ROOT="$PWD/ffmpeg-out/universal" -DCMAKE_BUILD_TYPE=Release
cmake --build native/build
lipo -archs native/build/unphased.uxpaddon    # must print: x86_64 arm64
cp native/build/unphased.uxpaddon mac/x64/
cp native/build/unphased.uxpaddon mac/arm64/
```

The output is a universal binary, so the same file serves both architectures; it
goes in both folders because that is where `build-ccx.js` looks.

**Check the `lipo` line rather than assuming.** Building universal takes two
things, and having only one of them fails quietly: `build-ffmpeg-mac.sh universal`
lipo's the *FFmpeg libs*, and `CMAKE_OSX_ARCHITECTURES` makes the *addon* that
links them universal too. `CMakeLists.txt` now defaults that to `arm64;x86_64`
(with a 11.0 deployment target matching the one the FFmpeg build pins), but a
stale `native/build/` cache or an explicit `-DCMAKE_OSX_ARCHITECTURES` on the
command line will override it. A single-slice addon copied into both folders
installs happily and then fails to load on the other architecture, reporting
only a generic "addon is not supported". `.github/workflows/mac-native-ci.yml`
and the release workflow both re-check with `lipo -archs`.

Unlike the Windows addon, the macOS one is **not committed** — it cannot be
built on the Windows dev machine, so `uxp/mac/` is gitignored and CI builds it
from source for every release.

### The decode harness on macOS

`tools/decode_smoke.cpp` builds here too, which is how CI runs the decode-core
tests that skip on Windows:

```bash
clang++ -std=c++17 -O2 \
  -I ffmpeg-out/universal/include -I native/src \
  native/tools/decode_smoke.cpp native/src/unphased_decode.cpp \
  -L ffmpeg-out/universal/lib -lavformat -lavcodec -lswresample -lavutil \
  -liconv -lz -lbz2 \
  -framework CoreFoundation -framework CoreVideo -framework CoreMedia \
  -framework CoreImage -framework Security -framework AudioToolbox \
  -framework VideoToolbox -framework Metal -framework AppKit -framework AVFoundation \
  -o native/build/decode_smoke
```

## Licensing

Bundling FFmpeg means complying with the **LGPL v2.1+**: this is an
LGPL-configured FFmpeg 8.1.2 (`--disable-everything` plus audio-only
components), with no GPL components enabled and no `--enable-gpl`. Source:
<https://ffmpeg.org>. If Unphased is ever distributed commercially, ship an offer
to provide the FFmpeg build scripts and objects for relinking.
