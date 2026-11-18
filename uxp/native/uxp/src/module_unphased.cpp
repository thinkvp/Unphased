/*
 * Unphased UXP hybrid addon — exposes the FFmpeg decode core to JS.
 *
 *   probe(path) -> { ok, error, durationSec,
 *                    streams: [{ index, channels, sampleRate, bits,
 *                                sampleFmt, codec }] }
 *
 *   decode(path, audioStream, channel, startSec, durationSec, sampleRate)
 *        -> { sampleRate, samples: ArrayBuffer }   // float32 mono, LE
 *        synchronous, on the UXP scripting thread
 *   decodeAsync(path, audioStream, channel, startSec, durationSec, sampleRate)
 *        -> Promise<{ sampleRate, samples: ArrayBuffer }>
 *        same decode on a background pool, so several run at once and the
 *        panel stays responsive while they do
 *   decodeThreads() -> size of that pool;  cpuCount() -> logical CPU threads
 *
 * `channel` is -1 to downmix the stream to mono, or 0..n-1 to pick one channel.
 * `sampleRate` is 0 to keep the stream's own rate. The contract is documented on
 * the JS side in js/audio.js — keep the two in step.
 *
 * Both paths share the decode core (unphased_decode.*). How many decodes JS
 * keeps in flight at once is limited on the JS side by a memory budget as well
 * as by this pool's size — see js/audio.js. Glue follows the bolt-uxp / Adobe
 * UXP addon C API (UxpAddonShared.h).
 */
#include <algorithm>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <mutex>
#include <new>
#include <string>
#include <thread>
#include <vector>

#include "utilities/UxpAddon.h"
#include "../../src/unphased_decode.h"

namespace {

// ─── Background decode pool ──────────────────────────────────────────────────
// About half the machine's logical CPU threads, less two left for Premiere
// itself, and never more than six: on a NAS share Syncitol measured throughput
// stop climbing at five or six concurrent decodes (the network, not the CPU,
// was then the limit), and a small machine keeps one — the same as the old
// one-at-a-time behaviour.
//   4 threads -> 1 · 8 -> 3 · 12 -> 5 · 16 and up -> 6
unsigned logicalCpus() {
    unsigned hw = std::thread::hardware_concurrency();
    return hw ? hw : 4;
}
unsigned decodeThreadCount() {
    int n = ((int)logicalCpus() - 2) / 2;
    return (unsigned)std::max(1, std::min(n, 6));
}

struct DecodeJob {
    std::string path;
    int32_t audioStream = 0, channel = -1, sampleRate = 0;
    double startSec = 0, durSec = 0;
    addon_env env = nullptr;
    addon_deferred deferred = nullptr;
    unphased::DecodeResult result;
};

// Results go back to JavaScript only while the addon is alive: once Terminate
// has run the env is gone, and a finished job is simply dropped.
std::mutex gAliveMutex;
bool gAlive = true;

addon_value makeError(addon_env env, const std::string& message) {
    addon_value code = nullptr, msg = nullptr, err = nullptr;
    UxpAddonApis.uxp_addon_create_string_utf8(env, "-1", 2, &code);
    UxpAddonApis.uxp_addon_create_string_utf8(env, message.c_str(), message.size(), &msg);
    UxpAddonApis.uxp_addon_create_error(env, code, msg, &err);
    return err;
}

// { sampleRate, samples: ArrayBuffer } from a successful decode, or nullptr if
// the ArrayBuffer could not be allocated. Shared by decode and decodeAsync so
// the two can never disagree on the result shape.
addon_value makeDecodeResult(addon_env env, const unphased::DecodeResult& r) {
    const size_t bytes = r.samples.size() * sizeof(float);
    void* data = nullptr;
    addon_value buf = nullptr;
    if (UxpAddonApis.uxp_addon_create_arraybuffer(env, bytes, &data, &buf) != addon_ok) return nullptr;
    if (data && bytes) std::memcpy(data, r.samples.data(), bytes);
    addon_value o = nullptr;
    if (UxpAddonApis.uxp_addon_create_object(env, &o) != addon_ok) return nullptr;
    addon_value rate = nullptr;
    UxpAddonApis.uxp_addon_create_double(env, (double)r.sampleRate, &rate);
    UxpAddonApis.uxp_addon_set_named_property(env, o, "sampleRate", rate);
    UxpAddonApis.uxp_addon_set_named_property(env, o, "samples", buf);
    return o;
}

// Runs on the scripting thread: hand the result (or the error) to the promise.
void resolveJob(addon_task_data data) {
    DecodeJob* job = reinterpret_cast<DecodeJob*>(data);
    try {
        HandlerScope scope(job->env);
        if (!job->result.ok) {
            const std::string& e = job->result.error;
            UxpAddonApis.uxp_addon_reject_deferred(job->env, job->deferred,
                makeError(job->env, e.empty() ? "decode failed" : e));
            return;
        }
        addon_value o = makeDecodeResult(job->env, job->result);
        // The native copy is no longer needed once JS has its own; free it now
        // rather than when the task is deleted.
        std::vector<float>().swap(job->result.samples);
        if (!o) {
            UxpAddonApis.uxp_addon_reject_deferred(job->env, job->deferred,
                makeError(job->env, "out of memory for decoded audio"));
            return;
        }
        UxpAddonApis.uxp_addon_resolve_deferred(job->env, job->deferred, o);
    } catch (...) {
        // Nothing more can be done for this promise from here.
    }
}
void deleteJob(addon_task_data data) {
    try { delete reinterpret_cast<DecodeJob*>(data); } catch (...) {}
}

class DecodePool {
 public:
    void post(DecodeJob* job) {
        {
            std::lock_guard<std::mutex> lk(mMutex);
            if (mThreads.empty() && !mStopping) {
                const unsigned n = decodeThreadCount();
                for (unsigned i = 0; i < n; i++) mThreads.emplace_back(&DecodePool::run, this);
            }
            mQueue.push_back(job);
        }
        mCv.notify_one();
    }

    // A panel reload can Init the addon again without unloading it.
    void allowRestart() {
        std::lock_guard<std::mutex> lk(mMutex);
        mStopping = false;
    }

    // Finish what is decoding, drop what is queued, and stop the threads.
    void stop() {
        std::vector<std::thread> threads;
        std::deque<DecodeJob*> queued;
        {
            std::lock_guard<std::mutex> lk(mMutex);
            mStopping = true;
            threads.swap(mThreads);
            queued.swap(mQueue);
        }
        mCv.notify_all();
        for (auto& t : threads) if (t.joinable()) t.join();
        for (DecodeJob* j : queued) delete j;
    }

 private:
    void run() {
        for (;;) {
            DecodeJob* job = nullptr;
            {
                std::unique_lock<std::mutex> lk(mMutex);
                mCv.wait(lk, [this] { return mStopping || !mQueue.empty(); });
                if (mStopping) return;
                job = mQueue.front();
                mQueue.pop_front();
            }
            try {
                job->result = unphased::decodeMono(job->path, job->audioStream, job->channel,
                                                   job->startSec, job->durSec, job->sampleRate);
            } catch (const std::bad_alloc&) {
                job->result = unphased::DecodeResult();
                job->result.error = "out of memory while decoding";
            } catch (...) {
                job->result = unphased::DecodeResult();
                job->result.error = "decode crashed";
            }
            std::lock_guard<std::mutex> alive(gAliveMutex);
            if (!gAlive) { delete job; continue; }
            UxpAddonApis.uxp_addon_schedule_on_javascript_queue(job->env, resolveJob, job, deleteJob);
        }
    }

    std::mutex mMutex;
    std::condition_variable mCv;
    std::deque<DecodeJob*> mQueue;
    std::vector<std::thread> mThreads;
    bool mStopping = false;
};

DecodePool& pool() {
    static DecodePool p;
    return p;
}

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
        addon_value o = makeDecodeResult(env, r);
        if (!o) {
            UxpAddonApis.uxp_addon_throw_error(env, nullptr, "out of memory for decoded audio");
            return nullptr;
        }
        return o;
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

// decodeAsync(path, audioStream, channel, startSec, durationSec, sampleRate)
//     -> Promise<{ sampleRate, samples: ArrayBuffer }>
addon_value DecodeAsync(addon_env env, addon_callback_info info) {
    try {
        size_t argc = 6;
        addon_value argv[6];
        Check(UxpAddonApis.uxp_addon_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
        std::string path;
        if (argc < 6 || !getStringArg(env, argv[0], path)) {
            UxpAddonApis.uxp_addon_throw_error(env, nullptr,
                "decodeAsync(path, audioStream, channel, startSec, durationSec, sampleRate)");
            return nullptr;
        }
        DecodeJob* job = new DecodeJob;
        job->path = path;
        job->env = env;
        if (UxpAddonApis.uxp_addon_get_value_int32(env, argv[1], &job->audioStream) != addon_ok ||
            UxpAddonApis.uxp_addon_get_value_int32(env, argv[2], &job->channel) != addon_ok ||
            UxpAddonApis.uxp_addon_get_value_double(env, argv[3], &job->startSec) != addon_ok ||
            UxpAddonApis.uxp_addon_get_value_double(env, argv[4], &job->durSec) != addon_ok ||
            UxpAddonApis.uxp_addon_get_value_int32(env, argv[5], &job->sampleRate) != addon_ok) {
            delete job;
            UxpAddonApis.uxp_addon_throw_error(env, nullptr,
                "decodeAsync: audioStream, channel, startSec, durationSec and sampleRate must be numbers");
            return nullptr;
        }
        addon_value promise = nullptr;
        if (UxpAddonApis.uxp_addon_create_promise(env, &job->deferred, &promise) != addon_ok) {
            delete job;
            UxpAddonApis.uxp_addon_throw_error(env, nullptr, "decodeAsync: could not create a promise");
            return nullptr;
        }
        pool().post(job);
        return promise;
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value DecodeThreads(addon_env env, addon_callback_info /*info*/) {
    addon_value v = nullptr;
    UxpAddonApis.uxp_addon_create_double(env, (double)decodeThreadCount(), &v);
    return v;
}

addon_value CpuCount(addon_env env, addon_callback_info /*info*/) {
    addon_value v = nullptr;
    UxpAddonApis.uxp_addon_create_double(env, (double)logicalCpus(), &v);
    return v;
}

addon_value Init(addon_env env, addon_value exports, const addon_apis& api) {
    {
        std::lock_guard<std::mutex> alive(gAliveMutex);
        gAlive = true;
    }
    pool().allowRestart();
    addon_value fn = nullptr;
    api.uxp_addon_create_function(env, nullptr, 0, Probe, nullptr, &fn);
    api.uxp_addon_set_named_property(env, exports, "probe", fn);
    api.uxp_addon_create_function(env, nullptr, 0, Decode, nullptr, &fn);
    api.uxp_addon_set_named_property(env, exports, "decode", fn);
    api.uxp_addon_create_function(env, nullptr, 0, DecodeAsync, nullptr, &fn);
    api.uxp_addon_set_named_property(env, exports, "decodeAsync", fn);
    api.uxp_addon_create_function(env, nullptr, 0, DecodeThreads, nullptr, &fn);
    api.uxp_addon_set_named_property(env, exports, "decodeThreads", fn);
    api.uxp_addon_create_function(env, nullptr, 0, CpuCount, nullptr, &fn);
    api.uxp_addon_set_named_property(env, exports, "cpuCount", fn);
    return exports;
}

// The panel is going away: stop handing results back first, then let the pool
// finish what it is decoding and drop the rest.
void Terminate(addon_env /*env*/) {
    {
        std::lock_guard<std::mutex> alive(gAliveMutex);
        gAlive = false;
    }
    pool().stop();
}

} // namespace

UXP_ADDON_INIT(Init)
UXP_ADDON_TERMINATE(Terminate)
