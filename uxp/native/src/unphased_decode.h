// unphased_decode.h — interface for the FFmpeg decode/probe core.
//
// This is the replacement for engine/src/decode.js, which shelled out to
// ffmpeg/ffprobe. Two entry points, matching the two things that module did:
// enumerate a file's audio layout, and decode one exact mono signal out of it.
#pragma once
#include <string>
#include <vector>
#include <cstdint>

namespace unphased {

struct StreamInfo {
    int index = 0;          // ordinal AMONG AUDIO STREAMS — the N in `-map 0:a:N`
    int channels = 1;
    int sampleRate = 0;
    int bits = 0;           // bits per raw sample, 0 when the container is silent about it
    std::string sampleFmt;  // "s16", "fltp", ... — drives the output WAV format
    std::string codec;
};

struct ProbeResult {
    bool ok = false;
    std::string error;
    double durationSec = 0.0;
    std::vector<StreamInfo> streams;
};

struct DecodeResult {
    bool ok = false;
    std::string error;
    int sampleRate = 0;             // the rate actually produced
    std::vector<float> samples;     // mono, float32, [-1, 1]
};

// Enumerate every audio stream. Replaces
//   ffprobe -select_streams a -show_entries stream=index,channels,...
ProbeResult probeFile(const std::string& path);

/**
 * Decode [startSec, startSec+durationSec) of one audio stream as mono float32.
 *
 * Replaces `ffmpeg -i F -ss S -t D -map 0:a:N -af pan=mono|c0=cC -ac 1 -ar R
 * -c:a pcm_f32le`. Note the ORDER of -ss: the engine deliberately used an
 * output seek, because an input seek lands on a container keyframe/priming
 * boundary and that error goes straight into the alignment result. This
 * function reproduces that: it seeks backwards to a safe point, then trims the
 * first decoded frame to the exact requested sample.
 *
 * @param audioStream ordinal among audio streams (0 = first audio stream)
 * @param channel     -1 downmixes the stream to mono; 0..n-1 selects one channel
 * @param sampleRate  0 keeps the stream's own rate
 */
DecodeResult decodeMono(const std::string& path, int audioStream, int channel,
                        double startSec, double durationSec, int sampleRate);

} // namespace unphased
