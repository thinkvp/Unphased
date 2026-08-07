// decode_smoke — a tiny CLI around the decode core, with no UXP in the picture.
//
// The addon itself can only run inside Premiere, but the part that can actually
// be wrong in a way that quietly poisons alignment — the sample-accurate window
// trimming and the channel selection — is plain C++. This harness lets
// tests/decode-core.test.js drive it against testmedia/ fixtures whose exact
// contents are known, and compare the bytes.
//
//   decode_smoke <path> <audioStream> <channel> <startSec> <durSec> <rate> <out.raw>
//   decode_smoke --probe <path>
//
// Build (from native/):
//   cl /std:c++17 /EHsc /MT /O2 /I third_party\ffmpeg-static\include /I src \
//      tools\decode_smoke.cpp src\unphased_decode.cpp \
//      /link /LIBPATH:third_party\ffmpeg-static\lib avformat.lib avcodec.lib \
//      swresample.lib avutil.lib Bcrypt.lib Mfplat.lib Mfuuid.lib Ole32.lib \
//      User32.lib Strmiids.lib Ws2_32.lib Secur32.lib /OUT:build\decode_smoke.exe
#include "unphased_decode.h"

#include <cstdio>
#include <cstdlib>
#include <string>

int main(int argc, char** argv) {
    if (argc >= 3 && std::string(argv[1]) == "--probe") {
        unphased::ProbeResult r = unphased::probeFile(argv[2]);
        if (!r.ok) { std::printf("{\"ok\":false,\"error\":\"%s\"}\n", r.error.c_str()); return 1; }
        std::printf("{\"ok\":true,\"durationSec\":%.6f,\"streams\":[", r.durationSec);
        for (size_t i = 0; i < r.streams.size(); i++) {
            const unphased::StreamInfo& s = r.streams[i];
            std::printf("%s{\"index\":%d,\"channels\":%d,\"sampleRate\":%d,\"bits\":%d,"
                        "\"sampleFmt\":\"%s\",\"codec\":\"%s\"}",
                        i ? "," : "", s.index, s.channels, s.sampleRate, s.bits,
                        s.sampleFmt.c_str(), s.codec.c_str());
        }
        std::printf("]}\n");
        return 0;
    }

    if (argc < 8) {
        std::fprintf(stderr,
            "usage: decode_smoke <path> <audioStream> <channel> <startSec> <durSec> <rate> <out.raw>\n"
            "       decode_smoke --probe <path>\n");
        return 2;
    }

    unphased::DecodeResult r = unphased::decodeMono(
        argv[1], std::atoi(argv[2]), std::atoi(argv[3]),
        std::atof(argv[4]), std::atof(argv[5]), std::atoi(argv[6]));
    if (!r.ok) { std::fprintf(stderr, "decode failed: %s\n", r.error.c_str()); return 1; }

    FILE* f = std::fopen(argv[7], "wb");
    if (!f) { std::fprintf(stderr, "cannot write %s\n", argv[7]); return 1; }
    std::fwrite(r.samples.data(), sizeof(float), r.samples.size(), f);
    std::fclose(f);

    std::printf("{\"sampleRate\":%d,\"samples\":%zu}\n", r.sampleRate, r.samples.size());
    return 0;
}
