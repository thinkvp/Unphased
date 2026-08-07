# Unphased native addon (`unphased.uxpaddon`)

The UXP plugin has no `child_process`, so it cannot shell out to ffmpeg the way
the CEP panel does. This addon is the replacement: a statically linked,
audio-only FFmpeg 8.1.2 wrapped in a UXP hybrid addon, exposing exactly the two
operations `engine/src/decode.js` used to get from the command line.

```
probe(path)
  -> { ok, error, durationSec,
       streams: [{ index, channels, sampleRate, bits, sampleFmt, codec }] }

decode(path, audioStream, channel, startSec, durationSec, sampleRate)
  -> { sampleRate, samples: ArrayBuffer }      // float32 mono, LE
```

`channel` is `-1` to downmix the stream to mono or `0..n-1` to select one
channel (`pan=mono|c0=cN`); `sampleRate` is `0` to keep the stream's own rate.
`index`/`audioStream` are ordinals **among audio streams** — the `N` in
`-map 0:a:N`. The JS side of the contract lives in [`../js/audio.js`](../js/audio.js);
keep the two in step.

The one thing this core does that Syncitol's equivalent did not is **trim the
first decoded frame to the exact requested sample**. A decoder handed a start
time will return the whole frame containing it — up to ~23 ms early for AAC —
and that error would land straight in the measured delay. `decodeMono` seeks
backward of the window and trims, which is what putting `-ss` *after* `-i`
bought the CEP build.

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

```bash
curl -fsSL -o ffmpeg.tar.xz https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz
tar xf ffmpeg.tar.xz
FFMPEG_SRC_DIR="$PWD/ffmpeg-8.1.2" PREFIX_BASE="$PWD/ffmpeg-out" \
  bash scripts/build-ffmpeg-mac.sh universal
cmake -S native -B native/build -DFFMPEG_ROOT="$PWD/ffmpeg-out/universal" -DCMAKE_BUILD_TYPE=Release
cmake --build native/build
cp native/build/unphased.uxpaddon mac/x64/
cp native/build/unphased.uxpaddon mac/arm64/
```

The universal binary covers both architectures; it goes in both folders because
that is where `build-ccx.js` looks.

## Licensing

Bundling FFmpeg means complying with the **LGPL v2.1+**: this is an
LGPL-configured FFmpeg 8.1.2 (`--disable-everything` plus audio-only
components), with no GPL components enabled and no `--enable-gpl`. Source:
<https://ffmpeg.org>. If Unphased is ever distributed commercially, ship an offer
to provide the FFmpeg build scripts and objects for relinking.
