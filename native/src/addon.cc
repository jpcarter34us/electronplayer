// N-API bridge between Electron's main process and libaudcore.
//
// libaudcore runs headless on its own "engine" thread, which owns the GLib
// main loop (aud_run). Every call from JS is queued onto that thread and
// answered with a Promise; engine hooks are pushed back to JS as
// BackendEvent-shaped objects (see src/shared/backend.ts). The two threads
// only exchange plain C++ data; N-API values are built on the JS thread.

#include <napi.h>

#include <algorithm>
#include <cstdlib>
#include <deque>
#include <functional>
#include <future>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <libaudcore/audstrings.h>
#include <libaudcore/drct.h>
#include <libaudcore/hook.h>
#include <libaudcore/i18n.h>
#include <libaudcore/mainloop.h>
#include <libaudcore/playlist.h>
#include <libaudcore/plugin.h>
#include <libaudcore/plugins.h>
#include <libaudcore/runtime.h>
#include <libaudcore/tuple.h>

namespace {

// ---- plain data snapshots (built on the engine thread) ----

struct TrackData
{
    std::string uri, title, artist, album;
    int length;
};

struct StateData
{
    bool playing, paused;
    int position, time, length, volume;
};

struct PluginData
{
    std::string id, name, type;
    bool enabled, has_prefs;
};

static std::string str (const String & s) { return s ? std::string (s) : std::string (); }

static std::string basename_of (const std::string & uri)
{
    auto slash = uri.find_last_of ('/');
    std::string name = (slash == std::string::npos) ? uri : uri.substr (slash + 1);
    auto dot = name.find_last_of ('.');
    return (dot == std::string::npos || dot == 0) ? name : name.substr (0, dot);
}

static StateData snapshot_state ()
{
    bool playing = aud_drct_get_playing ();
    return {playing,
            playing && aud_drct_get_paused (),
            Playlist::active_playlist ().get_position (),
            playing ? aud_drct_get_time () : 0,
            playing ? aud_drct_get_length () : -1,
            aud_drct_get_volume_main ()};
}

static std::vector<TrackData> snapshot_playlist ()
{
    auto pl = Playlist::active_playlist ();
    int n = pl.n_entries ();
    std::vector<TrackData> tracks;
    tracks.reserve (n);

    for (int i = 0; i < n; i++)
    {
        std::string uri = str (pl.entry_filename (i));
        Tuple tuple = pl.entry_tuple (i, Playlist::NoWait);
        TrackData t {uri, "", "", "", -1};

        if (tuple.state () == Tuple::Valid)
        {
            t.title = str (tuple.get_str (Tuple::Title));
            t.artist = str (tuple.get_str (Tuple::Artist));
            t.album = str (tuple.get_str (Tuple::Album));
            t.length = std::max (tuple.get_int (Tuple::Length), -1);
        }

        if (t.title.empty ())
            t.title = (const char *) str_decode_percent (basename_of (uri).c_str ());

        tracks.push_back (std::move (t));
    }

    return tracks;
}

static const char * type_name (PluginType type)
{
    switch (type)
    {
    case PluginType::Transport: return "transport";
    case PluginType::Playlist: return "playlist";
    case PluginType::Input: return "input";
    case PluginType::Effect: return "effect";
    case PluginType::Output: return "output";
    case PluginType::Vis: return "vis";
    case PluginType::General: return "general";
    case PluginType::Iface: return "iface";
    default: return "unknown";
    }
}

static std::vector<PluginData> snapshot_plugins ()
{
    std::vector<PluginData> plugins;
    for (int t = 0; t < (int) PluginType::count; t++)
    {
        for (PluginHandle * p : aud_plugin_list ((PluginType) t))
            plugins.push_back ({aud_plugin_get_basename (p), aud_plugin_get_name (p),
                                type_name ((PluginType) t), aud_plugin_get_enabled (p),
                                aud_plugin_has_configure (p)});
    }
    return plugins;
}

// ---- conversions to JS (JS thread) ----

static Napi::Value to_js (Napi::Env env, const StateData & s)
{
    auto o = Napi::Object::New (env);
    o.Set ("playing", s.playing);
    o.Set ("paused", s.paused);
    o.Set ("position", s.position);
    o.Set ("time", s.time);
    o.Set ("length", s.length);
    o.Set ("volume", s.volume);
    return o;
}

static Napi::Value to_js (Napi::Env env, const std::vector<TrackData> & tracks)
{
    auto a = Napi::Array::New (env, tracks.size ());
    for (size_t i = 0; i < tracks.size (); i++)
    {
        auto o = Napi::Object::New (env);
        o.Set ("uri", tracks[i].uri);
        o.Set ("title", tracks[i].title);
        if (!tracks[i].artist.empty ())
            o.Set ("artist", tracks[i].artist);
        if (!tracks[i].album.empty ())
            o.Set ("album", tracks[i].album);
        o.Set ("length", tracks[i].length);
        a.Set (i, o);
    }
    return a;
}

static Napi::Value to_js (Napi::Env env, const std::vector<PluginData> & plugins)
{
    auto a = Napi::Array::New (env, plugins.size ());
    for (size_t i = 0; i < plugins.size (); i++)
    {
        auto o = Napi::Object::New (env);
        o.Set ("id", plugins[i].id);
        o.Set ("name", plugins[i].name);
        o.Set ("type", plugins[i].type);
        o.Set ("enabled", plugins[i].enabled);
        o.Set ("hasPrefs", plugins[i].has_prefs);
        a.Set (i, o);
    }
    return a;
}

// ---- thread plumbing ----

using JsTask = std::function<void (Napi::Env, Napi::Function)>;

static std::thread engine;
static Napi::ThreadSafeFunction to_js_thread; // calls the onEvent callback
static bool running = false;

static std::mutex queue_mutex;
static std::deque<std::function<void ()>> pending;
static QueuedFunc pump;
static QueuedFunc ticker;

static void drain ()
{
    std::unique_lock<std::mutex> lock (queue_mutex);
    while (!pending.empty ())
    {
        auto fn = std::move (pending.front ());
        pending.pop_front ();
        lock.unlock ();
        fn ();
        lock.lock ();
    }
}

// Runs fn on the engine thread.
static void post (std::function<void ()> fn)
{
    {
        std::lock_guard<std::mutex> lock (queue_mutex);
        pending.push_back (std::move (fn));
    }
    pump.queue (drain); // replacing an unrun drain is fine: one drain empties all
}

// Runs task on the JS thread.
static void to_js_async (JsTask task)
{
    auto * heap = new JsTask (std::move (task));
    if (to_js_thread.NonBlockingCall (heap, [] (Napi::Env env, Napi::Function cb, JsTask * t) {
            (*t) (env, cb);
            delete t;
        }) != napi_ok)
        delete heap;
}

template<class T>
static void emit (const char * type, const char * key, T data)
{
    std::string type_str (type), key_str (key);
    to_js_async ([=] (Napi::Env env, Napi::Function cb) {
        auto ev = Napi::Object::New (env);
        ev.Set ("type", type_str);
        ev.Set (key_str, to_js (env, data));
        cb.Call ({ev});
    });
}

static void emit_state () { emit ("state", "state", snapshot_state ()); }
static void emit_playlist () { emit ("playlist", "tracks", snapshot_playlist ()); }

// ---- engine hooks (engine thread) ----

static void on_playback (void *, void *) { emit_state (); }

static void on_playlist (void *, void *)
{
    emit_playlist ();
    emit_state ();
}

static void on_error (void * data, void *)
{
    std::string message = data ? (const char *) data : "Unknown error";
    to_js_async ([message] (Napi::Env env, Napi::Function cb) {
        auto ev = Napi::Object::New (env);
        ev.Set ("type", "error");
        ev.Set ("message", message);
        cb.Call ({ev});
    });
}

static const char * const playback_hooks[] = {
    "playback begin", "playback ready", "playback pause", "playback unpause",
    "playback seek", "playback stop", "playback end", "title change", "info change"};
static const char * const playlist_hooks[] = {
    "playlist update", "playlist activate", "playlist position", "playlist set playing"};

static void engine_main (std::string config_home, std::promise<void> * ready)
{
    // Keep our config and playlists apart from a regular Audacious install.
    setenv ("XDG_CONFIG_HOME", config_home.c_str (), 1);

    aud_init_i18n ();
    aud_set_headless_mode (true);
    aud_init ();

    for (auto name : playback_hooks)
        hook_associate (name, on_playback, nullptr);
    for (auto name : playlist_hooks)
        hook_associate (name, on_playlist, nullptr);
    hook_associate ("ui show error", on_error, nullptr);

    // Position updates while playing; libaudcore has no per-tick hook.
    ticker.start (250, [] () {
        if (aud_drct_get_playing () && !aud_drct_get_paused ())
            emit_state ();
    });

    // Resolve once the main loop is actually running.
    QueuedFunc signal_ready;
    signal_ready.queue ([ready] () { ready->set_value (); });

    aud_run ();

    ticker.stop ();
    for (auto name : playback_hooks)
        hook_dissociate (name, on_playback);
    for (auto name : playlist_hooks)
        hook_dissociate (name, on_playlist);
    hook_dissociate ("ui show error", on_error);

    aud_cleanup ();
}

// Queues work on the engine thread and resolves a Promise with its result.
template<class Work>
static Napi::Value call (Napi::Env env, Work work)
{
    auto deferred = new Napi::Promise::Deferred (env);
    auto promise = deferred->Promise ();

    if (!running)
    {
        deferred->Reject (Napi::Error::New (env, "libaudcore is not running").Value ());
        delete deferred;
        return promise;
    }

    post ([deferred, work] () {
        auto make = work ();
        to_js_async ([deferred, make] (Napi::Env env, Napi::Function) {
            deferred->Resolve (make (env));
            delete deferred;
        });
    });
    return promise;
}

static auto undefined_result ()
{
    return [] (Napi::Env env) -> Napi::Value { return env.Undefined (); };
}

// ---- exported functions ----

Napi::Value Version (const Napi::CallbackInfo & info)
{
    return Napi::String::New (info.Env (),
        "plugin API " + std::to_string (_AUD_PLUGIN_VERSION));
}

// init(configHome: string, onEvent: (event) => void): Promise<void>
Napi::Value Init (const Napi::CallbackInfo & info)
{
    auto env = info.Env ();
    auto deferred = Napi::Promise::Deferred::New (env);

    if (running || info.Length () < 2 || !info[0].IsString () || !info[1].IsFunction ())
    {
        deferred.Reject (Napi::TypeError::New (env,
            running ? "already initialized" : "init(configHome, onEvent)").Value ());
        return deferred.Promise ();
    }

    to_js_thread = Napi::ThreadSafeFunction::New (env, info[1].As<Napi::Function> (),
                                                  "audcore-events", 0, 1);
    to_js_thread.Unref (env); // don't keep Electron alive on our account

    // Wait for the engine on a helper thread, then resolve on the JS thread.
    auto ready = new std::promise<void> ();
    auto ready_future = ready->get_future ().share ();
    auto pending_deferred = new Napi::Promise::Deferred (deferred);

    running = true;
    engine = std::thread (engine_main, info[0].As<Napi::String> ().Utf8Value (), ready);

    std::thread ([ready_future, ready, pending_deferred] () {
        ready_future.wait ();
        delete ready;
        to_js_async ([pending_deferred] (Napi::Env env, Napi::Function) {
            pending_deferred->Resolve (env.Undefined ());
            delete pending_deferred;
        });
    }).detach ();

    return deferred.Promise ();
}

// Stops playback, saves config and playlists, and joins the engine thread.
Napi::Value Shutdown (const Napi::CallbackInfo & info)
{
    if (running)
    {
        running = false;
        post (aud_quit);
        engine.join ();
        to_js_thread.Release ();
    }
    return info.Env ().Undefined ();
}

Napi::Value Play (const Napi::CallbackInfo & info)
{
    int pos = (info.Length () > 0 && info[0].IsNumber ()) ? info[0].As<Napi::Number> ().Int32Value () : -1;
    return call (info.Env (), [pos] () {
        auto pl = Playlist::active_playlist ();
        if (pos >= 0 && pos < pl.n_entries ())
        {
            pl.set_position (pos);
            pl.start_playback ();
        }
        else if (pos < 0)
            aud_drct_play ();
        return undefined_result ();
    });
}

#define SIMPLE(NAME, STMT) \
    Napi::Value NAME (const Napi::CallbackInfo & info) \
    { \
        return call (info.Env (), [] () { STMT; return undefined_result (); }); \
    }

SIMPLE (Pause, aud_drct_pause ())
SIMPLE (Stop, aud_drct_stop ())
SIMPLE (Next, aud_drct_pl_next ())
SIMPLE (Prev, aud_drct_pl_prev ())
SIMPLE (Clear, Playlist::active_playlist ().remove_all_entries ())

#undef SIMPLE

Napi::Value Seek (const Napi::CallbackInfo & info)
{
    int ms = info.Length () > 0 ? info[0].ToNumber ().Int32Value () : 0;
    return call (info.Env (), [ms] () {
        aud_drct_seek (ms);
        return undefined_result ();
    });
}

Napi::Value SetVolume (const Napi::CallbackInfo & info)
{
    int volume = std::clamp (info.Length () > 0 ? info[0].ToNumber ().Int32Value () : 100, 0, 100);
    return call (info.Env (), [volume] () {
        aud_drct_set_volume_main (volume);
        return undefined_result ();
    });
}

static std::vector<std::string> string_array (const Napi::Value & v)
{
    std::vector<std::string> out;
    if (v.IsArray ())
    {
        auto a = v.As<Napi::Array> ();
        for (uint32_t i = 0; i < a.Length (); i++)
            out.push_back (a.Get (i).ToString ().Utf8Value ());
    }
    return out;
}

static std::vector<int> int_array (const Napi::Value & v)
{
    std::vector<int> out;
    if (v.IsArray ())
    {
        auto a = v.As<Napi::Array> ();
        for (uint32_t i = 0; i < a.Length (); i++)
            out.push_back (a.Get (i).ToNumber ().Int32Value ());
    }
    return out;
}

// add(uris: string[]): Promise<void>; entries appear via "playlist" events
// as libaudcore's adder thread probes them.
Napi::Value Add (const Napi::CallbackInfo & info)
{
    auto uris = string_array (info.Length () > 0 ? info[0] : info.Env ().Undefined ());
    return call (info.Env (), [uris] () {
        Index<PlaylistAddItem> items;
        for (auto & uri : uris)
            items.append (String (uri.c_str ()));
        Playlist::active_playlist ().insert_items (-1, std::move (items), false);
        return undefined_result ();
    });
}

Napi::Value Remove (const Napi::CallbackInfo & info)
{
    auto positions = int_array (info.Length () > 0 ? info[0] : info.Env ().Undefined ());
    std::sort (positions.rbegin (), positions.rend ());
    positions.erase (std::unique (positions.begin (), positions.end ()), positions.end ());
    return call (info.Env (), [positions] () {
        auto pl = Playlist::active_playlist ();
        for (int pos : positions)
            if (pos >= 0 && pos < pl.n_entries ())
                pl.remove_entry (pos);
        return undefined_result ();
    });
}

Napi::Value GetPlaylist (const Napi::CallbackInfo & info)
{
    return call (info.Env (), [] () {
        auto tracks = snapshot_playlist ();
        return [tracks] (Napi::Env env) { return to_js (env, tracks); };
    });
}

Napi::Value GetState (const Napi::CallbackInfo & info)
{
    return call (info.Env (), [] () {
        auto state = snapshot_state ();
        return [state] (Napi::Env env) { return to_js (env, state); };
    });
}

Napi::Value ListPlugins (const Napi::CallbackInfo & info)
{
    return call (info.Env (), [] () {
        auto plugins = snapshot_plugins ();
        return [plugins] (Napi::Env env) { return to_js (env, plugins); };
    });
}

Napi::Object InitModule (Napi::Env env, Napi::Object exports)
{
    exports.Set ("version", Napi::Function::New (env, Version));
    exports.Set ("init", Napi::Function::New (env, Init));
    exports.Set ("shutdown", Napi::Function::New (env, Shutdown));
    exports.Set ("play", Napi::Function::New (env, Play));
    exports.Set ("pause", Napi::Function::New (env, Pause));
    exports.Set ("stop", Napi::Function::New (env, Stop));
    exports.Set ("next", Napi::Function::New (env, Next));
    exports.Set ("prev", Napi::Function::New (env, Prev));
    exports.Set ("seek", Napi::Function::New (env, Seek));
    exports.Set ("setVolume", Napi::Function::New (env, SetVolume));
    exports.Set ("add", Napi::Function::New (env, Add));
    exports.Set ("remove", Napi::Function::New (env, Remove));
    exports.Set ("clear", Napi::Function::New (env, Clear));
    exports.Set ("getPlaylist", Napi::Function::New (env, GetPlaylist));
    exports.Set ("getState", Napi::Function::New (env, GetState));
    exports.Set ("listPlugins", Napi::Function::New (env, ListPlugins));
    return exports;
}

} // namespace

NODE_API_MODULE (audcore, InitModule)
