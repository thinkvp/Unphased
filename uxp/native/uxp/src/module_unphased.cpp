/*
 * Unphased UXP hybrid addon — exposes the FFmpeg decode core to JS.
 *
 *   probe(path) -> { ok, error, durationSec,
 *                    streams: [{ index, channels, sampleRate, bits,
 *                                sampleFmt, codec }] }
 *
 *   decode(path, audioStream, channel, startSec, durationSec, sampleRate)
 *        -> { sampleRate, samples: ArrayBuffer }   // float32 mono, LE
 *
 * `channel` is -1 to downmix the stream to mono, or 0..n-1 to pick one channel.
 * `sampleRate` is 0 to keep the stream's own rate. The contract is documented on
 * the JS side in js/audio.js — keep the two in step.
 *
 * Synchronous (runs on the UXP scripting thread); js/audio.js yields to the UI
 * before each call so the panel stays responsive between decodes. Glue follows
 * the bolt-uxp / Adobe UXP addon C API (UxpAddonShared.h).
 */
#include <string>
#include <vector>
#include <cstring>

#include "utilities/UxpAddon.h"
#include "../../src/unphased_decode.h"

namespace {

bool getStringArg(addon_env env, addon_value v, std::string& out) {
    size_t len = 0;
    if (UxpAddonApis.uxp_addon_get_value_string_utf8(env, v, nullptr, 0, &len) != addon_ok) return false;
    out.resize(len + 1);
    size_t copied = 0;
    if (UxpAddonApis.uxp_addon_get_value_string_utf8(env, v, &out[0], len + 1, &copied) != addon_ok) return false;
    out.resize(copied);
    return true;
}

void setStr(addon_env env, addon_value obj, const char* name, const std::string& s) {
    addon_value v = nullptr;
    UxpAddonApis.uxp_addon_create_string_utf8(env, s.c_str(), s.size(), &v);
    UxpAddonApis.uxp_addon_set_named_property(env, obj, name, v);
}
void setNum(addon_env env, addon_value obj, const char* name, double d) {
    addon_value v = nullptr;
    UxpAddonApis.uxp_addon_create_double(env, d, &v);
    UxpAddonApis.uxp_addon_set_named_property(env, obj, name, v);
}
void setBool(addon_env env, addon_value obj, const char* name, bool b) {
    addon_value v = nullptr;
    UxpAddonApis.uxp_addon_get_boolean(env, b, &v);
    UxpAddonApis.uxp_addon_set_named_property(env, obj, name, v);
}

// probe(path) -> object
addon_value Probe(addon_env env, addon_callback_info info) {
    try {
        size_t argc = 1;
        addon_value argv[1];
        Check(UxpAddonApis.uxp_addon_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
        std::string path;
        if (argc < 1 || !getStringArg(env, argv[0], path)) {
            UxpAddonApis.uxp_addon_throw_error(env, nullptr, "probe(path) expects a string");
            return nullptr;
        }

        unphased::ProbeResult r = unphased::probeFile(path);
        addon_value o = nullptr;
        Check(UxpAddonApis.uxp_addon_create_object(env, &o));
        setBool(env, o, "ok", r.ok);
        setStr(env, o, "error", r.error);
        setNum(env, o, "durationSec", r.durationSec);

        addon_value arr = nullptr;
        Check(UxpAddonApis.uxp_addon_create_array_with_length(env, r.streams.size(), &arr));
        for (size_t i = 0; i < r.streams.size(); i++) {
            const unphased::StreamInfo& s = r.streams[i];
            addon_value e = nullptr;
            Check(UxpAddonApis.uxp_addon_create_object(env, &e));
            setNum(env, e, "index", s.index);
            setNum(env, e, "channels", s.channels);
            setNum(env, e, "sampleRate", s.sampleRate);
            setNum(env, e, "bits", s.bits);
            setStr(env, e, "sampleFmt", s.sampleFmt);
            setStr(env, e, "codec", s.codec);
            UxpAddonApis.uxp_addon_set_element(env, arr, (uint32_t)i, e);
        }
        UxpAddonApis.uxp_addon_set_named_property(env, o, "streams", arr);
        return o;
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

// decode(path, audioStream, channel, startSec, durationSec, sampleRate)
//     -> { sampleRate, samples: ArrayBuffer }
addon_value Decode(addon_env env, addon_callback_info info) {
    try {
        size_t argc = 6;
        addon_value argv[6];
        Check(UxpAddonApis.uxp_addon_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
        std::string path;
        if (argc < 6 || !getStringArg(env, argv[0], path)) {
            UxpAddonApis.uxp_addon_throw_error(env, nullptr,
                "decode(path, audioStream, channel, startSec, durationSec, sampleRate)");
            return nullptr;
        }
        int32_t audioStream = 0, channel = -1, sampleRate = 0;
        double startSec = 0, durSec = 0;
        Check(UxpAddonApis.uxp_addon_get_value_int32(env, argv[1], &audioStream));
        Check(UxpAddonApis.uxp_addon_get_value_int32(env, argv[2], &channel));
        Check(UxpAddonApis.uxp_addon_get_value_double(env, argv[3], &startSec));
        Check(UxpAddonApis.uxp_addon_get_value_double(env, argv[4], &durSec));
        Check(UxpAddonApis.uxp_addon_get_value_int32(env, argv[5], &sampleRate));

        unphased::DecodeResult r =
            unphased::decodeMono(path, audioStream, channel, startSec, durSec, sampleRate);
        if (!r.ok) {
            UxpAddonApis.uxp_addon_throw_error(env, nullptr,
                r.error.empty() ? "decode failed" : r.error.c_str());
            return nullptr;
        }

        const size_t bytes = r.samples.size() * sizeof(float);
        void* data = nullptr;
        addon_value buf = nullptr;
        Check(UxpAddonApis.uxp_addon_create_arraybuffer(env, bytes, &data, &buf));
        if (data && bytes) std::memcpy(data, r.samples.data(), bytes);

        addon_value o = nullptr;
        Check(UxpAddonApis.uxp_addon_create_object(env, &o));
        setNum(env, o, "sampleRate", r.sampleRate);
        UxpAddonApis.uxp_addon_set_named_property(env, o, "samples", buf);
        return o;
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value Init(addon_env env, addon_value exports, const addon_apis& api) {
    addon_value fn = nullptr;
    api.uxp_addon_create_function(env, nullptr, 0, Probe, nullptr, &fn);
    api.uxp_addon_set_named_property(env, exports, "probe", fn);
    api.uxp_addon_create_function(env, nullptr, 0, Decode, nullptr, &fn);
    api.uxp_addon_set_named_property(env, exports, "decode", fn);
    return exports;
}

void Terminate(addon_env /*env*/) {}

} // namespace

UXP_ADDON_INIT(Init)
UXP_ADDON_TERMINATE(Terminate)
