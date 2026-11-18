// unphased_decode.cpp — FFmpeg (libav*) audio decode + stream probe.
//
// Pure C++: no UXP/N-API here. This is the part that replaces the ffmpeg and
// ffprobe command-line calls in engine/src/decode.js; module_unphased.cpp is
// the thin glue that exposes it to JS.
//
// Two things matter more here than they did in Syncitol's equivalent, because
// Unphased measures sub-millisecond delays rather than second-scale offsets:
//
//  1. **Sample-accurate start.** A decoder handed `startSec` will happily give
//     you the whole frame that contains it — up to ~23 ms early for AAC. That
//     error lands directly in the measured delay. So we seek BACKWARD to a safe
//     point and then trim the first accepted frame to the exact input sample,
//     which is what `-ss` after `-i` bought the CEP build.
//
//  2. **Explicit channel selection.** `pan=mono|c0=cN` becomes a rematrix
//     matrix on the resampler. Downmixing a stereo source that carries two
//     DIFFERENT mics would blend them and make alignment meaningless, so the
//     caller is always explicit about which it wants.

#include "unphased_decode.h"

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/opt.h>
#include <libavutil/dict.h>
#include <libavutil/samplefmt.h>
#include <libavutil/channel_layout.h>
#include <libswresample/swresample.h>
}

#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

namespace unphased {
namespace {

// RAII so the many early returns below cannot leak a context.
struct Demuxer {
    AVFormatContext* fmt = nullptr;
    ~Demuxer() { if (fmt) avformat_close_input(&fmt); }
};
struct Decoder {
    AVCodecContext* ctx = nullptr;
    ~Decoder() { if (ctx) avcodec_free_context(&ctx); }
};
struct Resampler {
    SwrContext* swr = nullptr;
    ~Resampler() { if (swr) swr_free(&swr); }
};

int bitsForFormat(AVSampleFormat fmt) {
    const int bytes = av_get_bytes_per_sample(fmt);
    return bytes > 0 ? bytes * 8 : 0;
}

// Map an ordinal among audio streams (the N in `-map 0:a:N`) onto the absolute
// stream index the container uses.
int resolveAudioStream(AVFormatContext* fmt, int ordinal, int* outOrdinalCount) {
    int seen = 0;
    int found = -1;
    for (unsigned i = 0; i < fmt->nb_streams; i++) {
        if (fmt->streams[i]->codecpar &&
            fmt->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
            if (seen == ordinal && found < 0) found = (int)i;
            seen++;
        }
    }
    if (outOrdinalCount) *outOrdinalCount = seen;
    return found;
}

} // namespace

ProbeResult probeFile(const std::string& path) {
    ProbeResult r;
    Demuxer d;
    if (avformat_open_input(&d.fmt, path.c_str(), nullptr, nullptr) < 0) {
        r.error = "could not open file";
        return r;
    }
    if (avformat_find_stream_info(d.fmt, nullptr) < 0) {
        r.error = "could not read stream info";
        return r;
    }

    if (d.fmt->duration > 0) r.durationSec = (double)d.fmt->duration / AV_TIME_BASE;

    int ordinal = 0;
    for (unsigned i = 0; i < d.fmt->nb_streams; i++) {
        AVCodecParameters* p = d.fmt->streams[i]->codecpar;
        if (!p || p->codec_type != AVMEDIA_TYPE_AUDIO) continue;

        StreamInfo s;
        s.index = ordinal++;
        s.channels = p->ch_layout.nb_channels > 0 ? p->ch_layout.nb_channels : 1;
        s.sampleRate = p->sample_rate;
        // bits_per_raw_sample is what ffprobe reports and what the panel uses to
        // pick an output bit depth; fall back to the decoded format's width so a
        // container that omits it still renders at a sensible depth.
        s.bits = p->bits_per_raw_sample > 0
            ? p->bits_per_raw_sample
            : bitsForFormat((AVSampleFormat)p->format);
        const char* fmtName = av_get_sample_fmt_name((AVSampleFormat)p->format);
        if (fmtName) s.sampleFmt = fmtName;
        const AVCodecDescriptor* desc = avcodec_descriptor_get(p->codec_id);
        if (desc && desc->name) s.codec = desc->name;
        r.streams.push_back(s);
    }

    r.ok = true;
    return r;
}

DecodeResult decodeMono(const std::string& path, int audioStream, int channel,
                        double startSec, double durationSec, int sampleRate) {
    DecodeResult out;
    if (durationSec <= 0.0) { out.error = "durationSec must be > 0"; return out; }
    if (startSec < 0.0) startSec = 0.0;

    Demuxer d;
    if (avformat_open_input(&d.fmt, path.c_str(), nullptr, nullptr) < 0) {
        out.error = "open failed"; return out;
    }

    // Only the one audio stream is wanted. Discarding every other stream lets
    // the demuxer skip their data instead of reading it and throwing it away:
    // for a camera file that is the video, nearly all of its bytes, and over a
    // network share it was most of the time a decode took. (MP4/MOV skip a
    // discarded stream's samples outright; MXF steps over them.)
    const int wantOrdinal = audioStream < 0 ? 0 : audioStream;
    int audioCount = 0;
    int streamIndex = resolveAudioStream(d.fmt, wantOrdinal, &audioCount);
    auto discardOthers = [&](int keep) {
        for (unsigned i = 0; i < d.fmt->nb_streams; i++) {
            d.fmt->streams[i]->discard = ((int)i == keep) ? AVDISCARD_DEFAULT : AVDISCARD_ALL;
        }
    };
    if (streamIndex >= 0) discardOthers(streamIndex);

    // Probing reads ahead to fill in stream details. When the header already
    // describes the stream completely (MP4/MOV, MXF and WAV do) it is a second
    // read of the file for nothing, so only probe when it doesn't — or when no
    // audio stream showed up yet (formats whose streams appear only once
    // packets are read). probeFile() still always probes: it runs once per
    // file and reports fields only probing fills in.
    const AVCodecParameters* hp = streamIndex >= 0 ? d.fmt->streams[streamIndex]->codecpar : nullptr;
    const bool headerComplete = hp && hp->codec_id != AV_CODEC_ID_NONE &&
                                hp->sample_rate > 0 && hp->ch_layout.nb_channels > 0;
    if (!headerComplete) {
        if (avformat_find_stream_info(d.fmt, nullptr) < 0) {
            out.error = "stream info failed"; return out;
        }
        streamIndex = resolveAudioStream(d.fmt, wantOrdinal, &audioCount);
        if (streamIndex >= 0) discardOthers(streamIndex);
    }

    if (streamIndex < 0) {
        out.error = audioCount ? ("audio stream " + std::to_string(audioStream) + " does not exist (file has " +
                                  std::to_string(audioCount) + ")")
                               : "no audio stream";
        return out;
    }
    AVStream* st = d.fmt->streams[streamIndex];

    const AVCodec* codec = avcodec_find_decoder(st->codecpar->codec_id);
    if (!codec) { out.error = "no decoder for this codec"; return out; }
    Decoder dec;
    dec.ctx = avcodec_alloc_context3(codec);
    if (!dec.ctx) { out.error = "decoder alloc failed"; return out; }
    avcodec_parameters_to_context(dec.ctx, st->codecpar);
    if (avcodec_open2(dec.ctx, codec, nullptr) < 0) { out.error = "decoder open failed"; return out; }

    AVChannelLayout inLayout;
    av_channel_layout_copy(&inLayout, &dec.ctx->ch_layout);
    if (inLayout.nb_channels == 0) av_channel_layout_default(&inLayout, 2);
    const int inChannels = inLayout.nb_channels;
    if (channel >= inChannels) {
        av_channel_layout_uninit(&inLayout);
        out.error = "channel " + std::to_string(channel) + " does not exist (stream has " +
                    std::to_string(inChannels) + ")";
        return out;
    }

    const int inRate = dec.ctx->sample_rate > 0 ? dec.ctx->sample_rate : st->codecpar->sample_rate;
    if (inRate <= 0) { av_channel_layout_uninit(&inLayout); out.error = "unknown sample rate"; return out; }
    const int outRate = sampleRate > 0 ? sampleRate : inRate;
    out.sampleRate = outRate;

    AVChannelLayout monoLayout;
    av_channel_layout_default(&monoLayout, 1);

    Resampler rs;
    if (swr_alloc_set_opts2(&rs.swr, &monoLayout, AV_SAMPLE_FMT_FLT, outRate,
                            &inLayout, dec.ctx->sample_fmt, inRate, 0, nullptr) < 0 || !rs.swr) {
        av_channel_layout_uninit(&inLayout);
        av_channel_layout_uninit(&monoLayout);
        out.error = "resampler alloc failed";
        return out;
    }

    // `pan=mono|c0=cN`: a 1 x inChannels rematrix picking one channel, instead of
    // the default downmix. Must be set before swr_init().
    if (channel >= 0) {
        std::vector<double> matrix(inChannels, 0.0);
        matrix[channel] = 1.0;
        if (swr_set_matrix(rs.swr, matrix.data(), inChannels) < 0) {
            av_channel_layout_uninit(&inLayout);
            av_channel_layout_uninit(&monoLayout);
            out.error = "channel selection failed";
            return out;
        }
    }
    if (swr_init(rs.swr) < 0) {
        av_channel_layout_uninit(&inLayout);
        av_channel_layout_uninit(&monoLayout);
        out.error = "resampler init failed";
        return out;
    }
    av_channel_layout_uninit(&inLayout);
    av_channel_layout_uninit(&monoLayout);

    // Seek BACKWARD of the window, then trim precisely — see the file header.
    // A second of slack absorbs decoder priming and imprecise container indexes.
    const double seekSec = std::max(0.0, startSec - 1.0);
    const int64_t seekTs = (int64_t)std::llround(seekSec / av_q2d(st->time_base));
    if (av_seek_frame(d.fmt, streamIndex, seekTs, AVSEEK_FLAG_BACKWARD) >= 0) {
        avcodec_flush_buffers(dec.ctx);
    }

    const int64_t wantSamples = (int64_t)std::llround(durationSec * (double)outRate);
    out.samples.reserve((size_t)std::max<int64_t>(wantSamples, 0));

    const AVSampleFormat inFmt = dec.ctx->sample_fmt;
    const int inBytes = av_get_bytes_per_sample(inFmt);
    const bool planar = av_sample_fmt_is_planar(inFmt) != 0;

    AVPacket* pkt = av_packet_alloc();
    AVFrame* frame = av_frame_alloc();
    std::vector<float> conv;
    bool started = false;
    bool eof = false;
    bool full = false;

    auto drainInto = [&](const uint8_t** data, int nbSamples) {
        const int maxOut = (int)av_rescale_rnd(swr_get_delay(rs.swr, inRate) + nbSamples,
                                               outRate, inRate, AV_ROUND_UP) + 32;
        conv.resize((size_t)std::max(maxOut, 0));
        uint8_t* outBuf = reinterpret_cast<uint8_t*>(conv.data());
        const int got = swr_convert(rs.swr, &outBuf, maxOut, data, nbSamples);
        if (got <= 0) return;
        const int64_t room = wantSamples - (int64_t)out.samples.size();
        const int take = (int)std::min<int64_t>(got, std::max<int64_t>(room, 0));
        out.samples.insert(out.samples.end(), conv.begin(), conv.begin() + take);
        if ((int64_t)out.samples.size() >= wantSamples) full = true;
    };

    while (!full && !eof && av_read_frame(d.fmt, pkt) >= 0) {
        if (pkt->stream_index == streamIndex && avcodec_send_packet(dec.ctx, pkt) == 0) {
            while (!full && avcodec_receive_frame(dec.ctx, frame) == 0) {
                const int64_t pts = (frame->best_effort_timestamp != AV_NOPTS_VALUE)
                    ? frame->best_effort_timestamp : frame->pts;
                const double frameStart = (pts == AV_NOPTS_VALUE)
                    ? startSec : pts * av_q2d(st->time_base);
                const double frameEnd = frameStart + (double)frame->nb_samples / (double)inRate;

                if (!started) {
                    if (frameEnd <= startSec) continue;              // still before the window
                    // Trim this frame so the first sample we feed the resampler
                    // is exactly the one at startSec.
                    int64_t skip = (int64_t)std::llround((startSec - frameStart) * (double)inRate);
                    skip = std::max<int64_t>(0, std::min<int64_t>(skip, frame->nb_samples));
                    if (frameStart > startSec) {
                        // The stream begins after the window does (an input seek
                        // overshot, or the file starts late): pad rather than
                        // silently shifting the audio earlier.
                        const int64_t pad = (int64_t)std::llround((frameStart - startSec) * (double)outRate);
                        out.samples.insert(out.samples.end(),
                                           (size_t)std::min<int64_t>(pad, wantSamples), 0.0f);
                    }
                    started = true;
                    if (skip >= frame->nb_samples) continue;

                    const uint8_t* data[AV_NUM_DATA_POINTERS] = { nullptr };
                    const int planes = planar ? inChannels : 1;
                    for (int p = 0; p < planes && p < AV_NUM_DATA_POINTERS; p++) {
                        data[p] = frame->data[p] + skip * inBytes * (planar ? 1 : inChannels);
                    }
                    drainInto(data, (int)(frame->nb_samples - skip));
                    continue;
                }

                drainInto((const uint8_t**)frame->data, frame->nb_samples);
            }
        }
        av_packet_unref(pkt);
    }

    // Flush the decoder, then the resampler, so the tail of the window is not
    // lost to internal buffering.
    if (!full) {
        avcodec_send_packet(dec.ctx, nullptr);
        while (!full && avcodec_receive_frame(dec.ctx, frame) == 0) {
            if (!started) started = true;
            drainInto((const uint8_t**)frame->data, frame->nb_samples);
        }
        if (!full) drainInto(nullptr, 0);
    }

    av_frame_free(&frame);
    av_packet_free(&pkt);

    out.ok = !out.samples.empty();
    if (!out.ok && out.error.empty()) {
        out.error = "no samples decoded in the requested window";
    }
    return out;
}

} // namespace unphased
