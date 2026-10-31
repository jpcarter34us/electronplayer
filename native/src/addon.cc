// N-API bridge between Electron's main process and libaudcore.
//
// libaudcore runs headless on its own "engine" thread, which owns the GLib
// main loop (aud_run). Every call from JS is queued onto that thread and
// answered with a Promise; engine hooks are pushed back to JS as
// BackendEvent-shaped objects (see src/shared/backend.ts). The two threads
// only exchange plain C++ data; N-API values are built on the JS thread.
//
// Plugin preference trees (PreferencesWidget, libaudcore/preferences.h) are
// serialized to JSON so the renderer can build settings dialogs from the
// same declarations GTK and Qt use; see src/shared/prefs.ts.

#include <napi.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <functional>
#include <future>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

#include <libaudcore/audstrings.h>
#include <libaudcore/drct.h>
#include <libaudcore/equalizer.h>
#include <libaudcore/hook.h>
#include <libaudcore/i18n.h>
#include <libaudcore/interface.h>
#include <libaudcore/mainloop.h>
#include <libaudcore/playlist.h>
#include <libaudcore/plugin.h>
#include <libaudcore/plugins.h>
#include <libaudcore/preferences.h>
#include <libaudcore/runtime.h>
#include <libaudcore/tuple.h>
#include <libaudcore/visualizer.h>

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
    bool live; // the Music Assistant live stream is what's playing
};

// Music Assistant audio routed through libaudcore plays from its own
// playlist, so the user's playlist is never touched.
static const char LIVE_TITLE[] = "Music Assistant (live)";
static Playlist live_playlist;

static bool live_playing ()
{
    return live_playlist.exists () && aud_drct_get_playing () && Playlist::playing_playlist () == live_playlist;
}

struct PluginData
{
    std::string id, name, type;
    bool enabled, has_prefs, has_about;
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
            aud_drct_get_volume_main (),
            live_playing ()};
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
            // Honors the "Title format" setting, like the upstream playlist.
            t.title = str (tuple.get_str (Tuple::FormattedTitle));
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
                                aud_plugin_has_configure (p), aud_plugin_has_about (p)});
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
    if (s.live)
        o.Set ("live", true);
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
        o.Set ("hasAbout", plugins[i].has_about);
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

// Starts playback once items queued with insert_items(..., play = false)
// have been added. (insert_items' own play flag obeys "Clear the playlist
// when opening files", which would wipe the user's playlist.)
static struct
{
    Playlist playlist;
    int position = -1;
} pending_play;

static void on_add_complete (void *, void *)
{
    Playlist pl = pending_play.playlist;
    int pos = pending_play.position;
    pending_play = {};
    if (pl.exists () && pos >= 0 && pos < pl.n_entries ())
    {
        pl.set_position (pos);
        pl.start_playback ();
    }
}

static void remove_live_playlists ()
{
    for (int i = Playlist::n_playlists () - 1; i >= 0; i--)
    {
        Playlist p = Playlist::by_index (i);
        if (str (p.get_title ()) == LIVE_TITLE && Playlist::n_playlists () > 1)
            p.remove_playlist ();
    }
    live_playlist = Playlist ();
}
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
static void emit_equalizer ();
static void on_equalizer (void *, void *) { emit_equalizer (); }
static const char * const equalizer_hooks[] = {
    "set equalizer_active", "set equalizer_preamp", "set equalizer_bands"};
static void vis_stop ();

static const char * const playlist_hooks[] = {
    "playlist update", "playlist activate", "playlist position", "playlist set playing"};

#ifdef _WIN32
// Plugins load their own libraries (FLAC, FFmpeg, ...), which sit next to
// libaudcore rather than next to the executable, so add this module's folder
// to the DLL search path.
static void add_engine_dll_dir ()
{
    HMODULE self = nullptr;
    wchar_t path[MAX_PATH];
    if (!GetModuleHandleExW (GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                             GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                             (LPCWSTR) add_engine_dll_dir, &self) ||
        !GetModuleFileNameW (self, path, MAX_PATH))
        return;
    if (wchar_t * slash = wcsrchr (path, L'\\'))
        *slash = 0;
    SetDllDirectoryW (path);
}
#endif

static void engine_main (std::string config_home, std::promise<void> * ready)
{
    // Keep our config and playlists apart from a regular Audacious install.
#ifdef _WIN32
    add_engine_dll_dir ();
    _putenv_s ("XDG_CONFIG_HOME", config_home.c_str ());
#else
    setenv ("XDG_CONFIG_HOME", config_home.c_str (), 1);
#endif

    aud_init_i18n ();
    aud_set_headless_mode (true);
    aud_init ();

    for (auto name : playback_hooks)
        hook_associate (name, on_playback, nullptr);
    for (auto name : playlist_hooks)
        hook_associate (name, on_playlist, nullptr);
    hook_associate ("ui show error", on_error, nullptr);
    for (auto name : equalizer_hooks)
        hook_associate (name, on_equalizer, nullptr);
    hook_associate ("playlist add complete", on_add_complete, nullptr);
    remove_live_playlists (); // left over from a previous run

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
    for (auto name : equalizer_hooks)
        hook_dissociate (name, on_equalizer);
    hook_dissociate ("playlist add complete", on_add_complete);
    if (live_playlist.exists () && Playlist::playing_playlist () == live_playlist)
        aud_drct_stop ();
    remove_live_playlists (); // don't save it with the user's playlists
    vis_stop ();

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


// ---- JSON (preference trees and values go to JS as JSON text) ----

static void json_str (std::string & out, const char * s)
{
    out += '"';
    for (; s && *s; s++)
    {
        unsigned char c = *s;
        if (c == '"' || c == '\\')
            (out += '\\') += c;
        else if (c == '\n')
            out += "\\n";
        else if (c < 0x20)
        {
            char buf[8];
            snprintf (buf, sizeof buf, "\\u%04x", c);
            out += buf;
        }
        else
            out += c;
    }
    out += '"';
}

static std::string json_num (double v)
{
    char buf[32];
    snprintf (buf, sizeof buf, "%.10g", v);
    return buf;
}

static Napi::Value parse_json (Napi::Env env, const std::string & json)
{
    auto parse = env.Global ().Get ("JSON").As<Napi::Object> ().Get ("parse").As<Napi::Function> ();
    return parse.Call ({Napi::String::New (env, json)});
}

static auto json_result (std::string json)
{
    return [json] (Napi::Env env) { return parse_json (env, json); };
}

// ---- plugin preference sessions (engine thread only) ----

struct PrefsSession
{
    const PluginPreferences * prefs;
    std::vector<const PreferencesWidget *> widgets; // index = widget id
};

static std::map<int, PrefsSession> prefs_sessions;
static int next_prefs_session = 1;

static const char * cfg_type_name (WidgetConfig::Type type)
{
    switch (type)
    {
    case WidgetConfig::Bool: return "bool";
    case WidgetConfig::Int: return "int";
    case WidgetConfig::Float: return "float";
    case WidgetConfig::String: return "string";
    default: return nullptr;
    }
}

static void serialize_widgets (std::string & out, ArrayRef<PreferencesWidget> widgets, PrefsSession & session);

static void serialize_widget (std::string & out, const PreferencesWidget & w, PrefsSession & session)
{
    static const char * const kinds[] = {
        "label", "button", "check", "radio", "spin", "entry", "file", "combo",
        "font", "box", "table", "notebook", "separator", "custom", "custom"};

    int id = session.widgets.size ();
    session.widgets.push_back (&w);

    out += "{\"id\":" + std::to_string (id) + ",\"type\":\"" + kinds[w.type] + '"';
    if (w.label)
    {
        out += ",\"label\":";
        json_str (out, w.label);
    }
    if (w.child)
        out += ",\"child\":true";
    if (auto cfg = cfg_type_name (w.cfg.type))
        out += std::string (",\"cfg\":\"") + cfg + '"';

    switch (w.type)
    {
    case PreferencesWidget::RadioButton:
        out += ",\"value\":" + std::to_string (w.data.radio_btn.value);
        break;
    case PreferencesWidget::SpinButton:
        out += ",\"min\":" + json_num (w.data.spin_btn.min) + ",\"max\":" + json_num (w.data.spin_btn.max) +
               ",\"step\":" + json_num (w.data.spin_btn.step);
        if (w.data.spin_btn.right_label)
        {
            out += ",\"unit\":";
            json_str (out, w.data.spin_btn.right_label);
        }
        break;
    case PreferencesWidget::Entry:
        if (w.data.entry.password)
            out += ",\"password\":true";
        break;
    case PreferencesWidget::FileEntry:
        out += std::string (",\"mode\":\"") + (w.data.file_entry.mode == FileSelectMode::Folder ? "folder" : "file") + '"';
        break;
    case PreferencesWidget::ComboBox:
    {
        auto items = w.data.combo.fill ? w.data.combo.fill () : w.data.combo.elems;
        out += ",\"items\":[";
        for (int i = 0; i < items.len; i++)
        {
            if (i)
                out += ',';
            out += "{\"label\":";
            json_str (out, items.data[i].label);
            out += ",\"value\":";
            if (items.data[i].str)
                json_str (out, items.data[i].str);
            else
                out += std::to_string (items.data[i].num);
            out += '}';
        }
        out += ']';
        break;
    }
    case PreferencesWidget::Box:
        out += std::string (",\"horizontal\":") + (w.data.box.horizontal ? "true" : "false") +
               ",\"frame\":" + (w.data.box.frame ? "true" : "false") + ",\"children\":";
        serialize_widgets (out, w.data.box.widgets, session);
        break;
    case PreferencesWidget::Table:
        out += ",\"children\":";
        serialize_widgets (out, w.data.table.widgets, session);
        break;
    case PreferencesWidget::Notebook:
        out += ",\"tabs\":[";
        for (int i = 0; i < w.data.notebook.tabs.len; i++)
        {
            if (i)
                out += ',';
            out += "{\"name\":";
            json_str (out, w.data.notebook.tabs.data[i].name);
            out += ",\"children\":";
            serialize_widgets (out, w.data.notebook.tabs.data[i].widgets, session);
            out += '}';
        }
        out += ']';
        break;
    case PreferencesWidget::Separator:
        out += std::string (",\"horizontal\":") + (w.data.separator.horizontal ? "true" : "false");
        break;
    default:
        break;
    }

    out += '}';
}

static void serialize_widgets (std::string & out, ArrayRef<PreferencesWidget> widgets, PrefsSession & session)
{
    out += '[';
    for (int i = 0; i < widgets.len; i++)
    {
        if (i)
            out += ',';
        serialize_widget (out, widgets.data[i], session);
    }
    out += ']';
}

// {"<id>": value, ...} for every widget bound to a setting.
static std::string serialize_values (const PrefsSession & session)
{
    std::string out = "{";
    bool first = true;
    for (size_t id = 0; id < session.widgets.size (); id++)
    {
        const WidgetConfig & cfg = session.widgets[id]->cfg;
        if (cfg.type == WidgetConfig::None)
            continue;
        if (!first)
            out += ',';
        first = false;
        out += '"' + std::to_string (id) + "\":";
        switch (cfg.type)
        {
        case WidgetConfig::Bool: out += cfg.get_bool () ? "true" : "false"; break;
        case WidgetConfig::Int: out += std::to_string (cfg.get_int ()); break;
        case WidgetConfig::Float: out += json_num (cfg.get_float ()); break;
        case WidgetConfig::String: json_str (out, cfg.get_string ()); break;
        default: break;
        }
    }
    return out + '}';
}

// A value from JS, converted on the JS thread.
struct PrefValue
{
    bool b = false;
    double num = 0;
    std::string str;
};

static PrefValue pref_value (const Napi::Value & v)
{
    PrefValue out;
    if (v.IsBoolean ())
        out.b = v.As<Napi::Boolean> ().Value (), out.num = out.b;
    else if (v.IsNumber ())
        out.num = v.As<Napi::Number> ().DoubleValue (), out.b = out.num != 0;
    else if (!v.IsUndefined () && !v.IsNull ())
        out.str = v.ToString ().Utf8Value ();
    return out;
}

static void apply_cfg (const WidgetConfig & cfg, const PrefValue & v)
{
    switch (cfg.type)
    {
    case WidgetConfig::Bool: cfg.set_bool (v.b); break;
    case WidgetConfig::Int: cfg.set_int ((int) v.num); break;
    case WidgetConfig::Float: cfg.set_float (v.num); break;
    case WidgetConfig::String: cfg.set_string (v.str.c_str ()); break;
    default: break;
    }
}

// ---- equalizer ----

static std::string serialize_eq ()
{
    double bands[AUD_EQ_NBANDS];
    aud_eq_get_bands (bands);
    std::string out = std::string ("{\"active\":") + (aud_get_bool ("equalizer_active") ? "true" : "false") +
                      ",\"preamp\":" + json_num (aud_get_double ("equalizer_preamp")) + ",\"bands\":[";
    for (int i = 0; i < AUD_EQ_NBANDS; i++)
        out += (i ? "," : "") + json_num (bands[i]);
    return out + "]}";
}

static void emit_equalizer ()
{
    std::string json = serialize_eq ();
    to_js_async ([json] (Napi::Env env, Napi::Function cb) {
        auto ev = Napi::Object::New (env);
        ev.Set ("type", "equalizer");
        ev.Set ("equalizer", parse_json (env, json));
        cb.Call ({ev});
    });
}

// ---- visualization ----

// Streams libaudcore's vis frames (~30/s while playing) to JS: 512 mono PCM
// samples, 256 frequency intensities and per-channel peak levels.
class VisBridge final : public Visualizer
{
public:
    VisBridge () : Visualizer (MonoPCM | MultiPCM | Freq) {}

    void clear () override
    {
        to_js_async ([] (Napi::Env env, Napi::Function cb) {
            auto ev = Napi::Object::New (env);
            ev.Set ("type", "vis-clear");
            cb.Call ({ev});
        });
    }

    void render_mono_pcm (const float * pcm) override { mono.assign (pcm, pcm + 512); }

    void render_multi_pcm (const float * pcm, int channels) override
    {
        levels.assign (channels, 0);
        for (int i = 0; i < 512 * channels; i++)
            levels[i % channels] = std::max (levels[i % channels], std::abs (pcm[i]));
    }

    // Called last for each frame (visualization.cc), so it sends the frame.
    void render_freq (const float * freq) override
    {
        std::vector<float> f (freq, freq + 256);
        auto m = mono;
        auto l = levels;
        to_js_async ([f, m, l] (Napi::Env env, Napi::Function cb) {
            auto copy = [&] (const std::vector<float> & v) {
                auto a = Napi::Float32Array::New (env, v.size ());
                std::copy (v.begin (), v.end (), a.Data ());
                return a;
            };
            auto ev = Napi::Object::New (env);
            ev.Set ("type", "vis");
            ev.Set ("freq", copy (f));
            ev.Set ("pcm", copy (m));
            ev.Set ("levels", copy (l));
            cb.Call ({ev});
        });
    }

private:
    std::vector<float> mono = std::vector<float> (512, 0), levels;
};

static VisBridge * vis_bridge = nullptr;

static void vis_start ()
{
    if (!vis_bridge)
        aud_visualizer_add (vis_bridge = new VisBridge);
}

static void vis_stop ()
{
    if (vis_bridge)
    {
        aud_visualizer_remove (vis_bridge);
        delete vis_bridge;
        vis_bridge = nullptr;
    }
}

// ---- playlist and playback commands (menu items without a dedicated API) ----

static bool run_command (const std::string & name, const std::string & arg)
{
    static const std::map<std::string, Playlist::SortType> sort_types = {
        {"path", Playlist::Path}, {"filename", Playlist::Filename}, {"title", Playlist::Title},
        {"album", Playlist::Album}, {"artist", Playlist::Artist}, {"album-artist", Playlist::AlbumArtist},
        {"date", Playlist::Date}, {"genre", Playlist::Genre}, {"track", Playlist::Track},
        {"custom-title", Playlist::FormattedTitle}, {"length", Playlist::Length},
        {"comment", Playlist::Comment}, {"disc", Playlist::Disc}, {"bitrate", Playlist::Bitrate},
        {"file-created", Playlist::FileCreated}, {"file-modified", Playlist::FileModified}};

    auto pl = Playlist::active_playlist ();

    if (name == "prev-album") aud_drct_pl_prev_album ();
    else if (name == "next-album") aud_drct_pl_next_album ();
    else if (name == "play-resume") pl.start_playback ();
    else if (name == "refresh") pl.rescan_all ();
    else if (name == "reverse") pl.reverse_order ();
    else if (name == "randomize") pl.randomize_order ();
    else if (name == "remove-unavailable") pl.remove_unavailable ();
    else if ((name == "sort" || name == "remove-duplicates") && sort_types.count (arg))
    {
        if (name == "sort")
            pl.sort_entries (sort_types.at (arg));
        else
            pl.remove_duplicates (sort_types.at (arg));
    }
    else if (name == "ab-a" || name == "ab-b" || name == "ab-clear")
    {
        int a, b;
        aud_drct_get_ab_repeat (a, b);
        if (name == "ab-clear")
            a = b = -1;
        else if (!aud_drct_get_playing ())
            return false;
        else if (name == "ab-a")
            a = aud_drct_get_time ();
        else
            b = aud_drct_get_time ();
        aud_drct_set_ab_repeat (a, b);
    }
    else
        return false;

    return true;
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

// open(uris: string[]): like File > Open; honors "Clear the playlist when
// opening files" and "Open files in a temporary playlist", then plays.
Napi::Value Open (const Napi::CallbackInfo & info)
{
    auto uris = string_array (info.Length () > 0 ? info[0] : info.Env ().Undefined ());
    return call (info.Env (), [uris] () {
        Index<PlaylistAddItem> items;
        for (auto & uri : uris)
            items.append (String (uri.c_str ()));
        aud_drct_pl_open_list (std::move (items));
        return undefined_result ();
    });
}

// insert(entries: {uri, title?, artist?, album?, length?}[], at = -1, play = false)
// Known metadata goes in as a valid tuple, so the playlist shows it without
// probing each entry (which for network sources means a request per track).
// Returns the position of the first inserted entry.
Napi::Value Insert (const Napi::CallbackInfo & info)
{
    struct Entry { std::string uri, title, artist, album; int length; };
    std::vector<Entry> entries;
    if (info.Length () > 0 && info[0].IsArray ())
    {
        auto a = info[0].As<Napi::Array> ();
        for (uint32_t i = 0; i < a.Length (); i++)
        {
            if (!a.Get (i).IsObject ())
                continue;
            auto o = a.Get (i).As<Napi::Object> ();
            auto str_field = [&] (const char * key) {
                auto v = o.Get (key);
                return v.IsString () ? v.As<Napi::String> ().Utf8Value () : std::string ();
            };
            auto len = o.Get ("length");
            entries.push_back ({str_field ("uri"), str_field ("title"), str_field ("artist"), str_field ("album"),
                                len.IsNumber () ? len.As<Napi::Number> ().Int32Value () : -1});
        }
    }
    int at = (info.Length () > 1 && info[1].IsNumber ()) ? info[1].As<Napi::Number> ().Int32Value () : -1;
    bool play = info.Length () > 2 && info[2].ToBoolean ().Value ();

    return call (info.Env (), [entries, at, play] () {
        auto pl = Playlist::active_playlist ();
        int pos = (at < 0 || at > pl.n_entries ()) ? pl.n_entries () : at;
        Index<PlaylistAddItem> items;
        for (auto & e : entries)
        {
            Tuple tuple;
            if (!e.title.empty ())
            {
                tuple.set_filename (e.uri.c_str ());
                tuple.set_str (Tuple::Title, e.title.c_str ());
                if (!e.artist.empty ())
                    tuple.set_str (Tuple::Artist, e.artist.c_str ());
                if (!e.album.empty ())
                    tuple.set_str (Tuple::Album, e.album.c_str ());
                if (e.length > 0)
                    tuple.set_int (Tuple::Length, e.length);
                tuple.set_state (Tuple::Valid);
            }
            items.append (String (e.uri.c_str ()), std::move (tuple));
        }
        pl.insert_items (pos, std::move (items), false);
        if (play)
            pending_play = {pl, pos};
        return [pos] (Napi::Env env) -> Napi::Value { return Napi::Number::New (env, pos); };
    });
}

// playLive(uri, title): plays a live stream from the hidden live playlist.
Napi::Value PlayLive (const Napi::CallbackInfo & info)
{
    std::string uri = info.Length () > 0 ? info[0].ToString ().Utf8Value () : "";
    std::string title = (info.Length () > 1 && info[1].IsString ()) ? info[1].As<Napi::String> ().Utf8Value () : "Music Assistant";
    return call (info.Env (), [uri, title] () {
        if (!live_playlist.exists ())
        {
            live_playlist = Playlist::insert_playlist (-1);
            live_playlist.set_title (LIVE_TITLE);
        }
        live_playlist.remove_all_entries ();
        Tuple tuple;
        tuple.set_filename (uri.c_str ());
        tuple.set_str (Tuple::Title, title.c_str ());
        tuple.set_state (Tuple::Valid);
        Index<PlaylistAddItem> items;
        items.append (String (uri.c_str ()), std::move (tuple));
        live_playlist.insert_items (0, std::move (items), false);
        pending_play = {live_playlist, 0};
        return undefined_result ();
    });
}

// stopLive(): stops the live stream (if it is playing) and drops its playlist.
Napi::Value StopLive (const Napi::CallbackInfo & info)
{
    return call (info.Env (), [] () {
        if (pending_play.playlist == live_playlist)
            pending_play = {};
        if (live_playing ())
            aud_drct_stop ();
        remove_live_playlists ();
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


static PluginHandle * plugin_arg (const Napi::CallbackInfo & info)
{
    return (info.Length () > 0 && info[0].IsString ())
               ? aud_plugin_lookup_basename (info[0].As<Napi::String> ().Utf8Value ().c_str ())
               : nullptr;
}

static Napi::Value reject (Napi::Env env, const char * message)
{
    auto deferred = Napi::Promise::Deferred::New (env);
    deferred.Reject (Napi::Error::New (env, message).Value ());
    return deferred.Promise ();
}

// getConfig(section: string | null, name: string, type: 'bool'|'int'|'float'|'string')
Napi::Value GetConfig (const Napi::CallbackInfo & info)
{
    if (info.Length () < 3)
        return reject (info.Env (), "getConfig(section, name, type)");
    std::string section = info[0].IsString () ? info[0].As<Napi::String> ().Utf8Value () : "";
    std::string name = info[1].ToString ().Utf8Value ();
    std::string type = info[2].ToString ().Utf8Value ();
    return call (info.Env (), [section, name, type] () {
        const char * sec = section.empty () ? nullptr : section.c_str ();
        std::string json;
        if (type == "bool") json = aud_get_bool (sec, name.c_str ()) ? "true" : "false";
        else if (type == "int") json = std::to_string (aud_get_int (sec, name.c_str ()));
        else if (type == "float") json = json_num (aud_get_double (sec, name.c_str ()));
        else json_str (json, aud_get_str (sec, name.c_str ()));
        return json_result (json);
    });
}

// setConfig(section: string | null, name: string, type, value)
Napi::Value SetConfig (const Napi::CallbackInfo & info)
{
    if (info.Length () < 4)
        return reject (info.Env (), "setConfig(section, name, type, value)");
    std::string section = info[0].IsString () ? info[0].As<Napi::String> ().Utf8Value () : "";
    std::string name = info[1].ToString ().Utf8Value ();
    std::string type = info[2].ToString ().Utf8Value ();
    PrefValue v = pref_value (info[3]);
    return call (info.Env (), [section, name, type, v] () {
        const char * sec = section.empty () ? nullptr : section.c_str ();
        if (type == "bool") aud_set_bool (sec, name.c_str (), v.b);
        else if (type == "int") aud_set_int (sec, name.c_str (), (int) v.num);
        else if (type == "float") aud_set_double (sec, name.c_str (), v.num);
        else aud_set_str (sec, name.c_str (), v.str.c_str ());

        // Side effects the Qt settings window performs for core settings.
        if (!sec && name == "output_bit_depth")
            aud_output_reset (OutputReset::ReopenStream);
        return undefined_result ();
    });
}

// enablePlugin(id, enable): Promise<boolean>. Enabling an output plugin
// switches to it.
Napi::Value EnablePlugin (const Napi::CallbackInfo & info)
{
    PluginHandle * p = plugin_arg (info);
    bool enable = info.Length () > 1 && info[1].ToBoolean ().Value ();
    return call (info.Env (), [p, enable] () {
        bool ok = p && aud_plugin_enable (p, enable);
        return [ok] (Napi::Env env) -> Napi::Value { return Napi::Boolean::New (env, ok); };
    });
}

Napi::Value PluginAbout (const Napi::CallbackInfo & info)
{
    PluginHandle * p = plugin_arg (info);
    return call (info.Env (), [p] () {
        auto header = p ? (const Plugin *) aud_plugin_get_header (p) : nullptr;
        std::string about = (header && header->info.about) ? header->info.about : "";
        return [about] (Napi::Env env) -> Napi::Value { return Napi::String::New (env, about); };
    });
}

// openPrefs(id): Promise<{ session, name, hasApply, widgets, values }>.
// Calls the plugin's init(); pair with closePrefs(session).
Napi::Value OpenPrefs (const Napi::CallbackInfo & info)
{
    PluginHandle * p = plugin_arg (info);
    if (!p)
        return reject (info.Env (), "unknown plugin");
    return call (info.Env (), [p] () {
        auto header = (const Plugin *) aud_plugin_get_header (p);
        if (!header || !header->info.prefs)
            return json_result ("null");

        int id = next_prefs_session++;
        PrefsSession & session = prefs_sessions[id];
        session.prefs = header->info.prefs;
        if (session.prefs->init)
            session.prefs->init ();

        std::string json = "{\"session\":" + std::to_string (id) + ",\"name\":";
        json_str (json, aud_plugin_get_name (p));
        json += std::string (",\"hasApply\":") + (session.prefs->apply ? "true" : "false") + ",\"widgets\":";
        serialize_widgets (json, session.prefs->widgets, session);
        json += ",\"values\":" + serialize_values (session) + '}';
        return json_result (json);
    });
}

static int session_arg (const Napi::CallbackInfo & info)
{
    return info.Length () > 0 ? info[0].ToNumber ().Int32Value () : 0;
}

// Runs fn against a live session and resolves with its current values
// (a change can update other widgets).
template<class Fn>
static Napi::Value with_session (const Napi::CallbackInfo & info, Fn fn)
{
    int id = session_arg (info);
    return call (info.Env (), [id, fn] () {
        auto it = prefs_sessions.find (id);
        if (it == prefs_sessions.end ())
            return json_result ("null");
        fn (it->second);
        return json_result (serialize_values (it->second));
    });
}

Napi::Value PrefsGet (const Napi::CallbackInfo & info)
{
    return with_session (info, [] (PrefsSession &) {});
}

// prefsSet(session, widgetId, value)
Napi::Value PrefsSet (const Napi::CallbackInfo & info)
{
    int widget = info.Length () > 1 ? info[1].ToNumber ().Int32Value () : -1;
    PrefValue v = pref_value (info.Length () > 2 ? info[2] : info.Env ().Undefined ());
    return with_session (info, [widget, v] (PrefsSession & s) {
        if (widget >= 0 && widget < (int) s.widgets.size ())
            apply_cfg (s.widgets[widget]->cfg, v);
    });
}

// prefsButton(session, widgetId)
Napi::Value PrefsButton (const Napi::CallbackInfo & info)
{
    int widget = info.Length () > 1 ? info[1].ToNumber ().Int32Value () : -1;
    return with_session (info, [widget] (PrefsSession & s) {
        if (widget >= 0 && widget < (int) s.widgets.size () &&
            s.widgets[widget]->type == PreferencesWidget::Button && s.widgets[widget]->data.button.callback)
            s.widgets[widget]->data.button.callback ();
    });
}

Napi::Value PrefsApply (const Napi::CallbackInfo & info)
{
    return with_session (info, [] (PrefsSession & s) {
        if (s.prefs->apply)
            s.prefs->apply ();
    });
}

Napi::Value ClosePrefs (const Napi::CallbackInfo & info)
{
    int id = session_arg (info);
    return call (info.Env (), [id] () {
        auto it = prefs_sessions.find (id);
        if (it != prefs_sessions.end ())
        {
            if (it->second.prefs->cleanup)
                it->second.prefs->cleanup ();
            prefs_sessions.erase (it);
        }
        return undefined_result ();
    });
}

Napi::Value GetEqualizer (const Napi::CallbackInfo & info)
{
    return call (info.Env (), [] () { return json_result (serialize_eq ()); });
}

// setEqualizer({ active?, preamp?, bands? }); any field may be omitted.
Napi::Value SetEqualizer (const Napi::CallbackInfo & info)
{
    if (info.Length () < 1 || !info[0].IsObject ())
        return reject (info.Env (), "setEqualizer({ active?, preamp?, bands? })");
    auto o = info[0].As<Napi::Object> ();
    int active = o.Has ("active") ? o.Get ("active").ToBoolean ().Value () : -1;
    bool has_preamp = o.Has ("preamp");
    double preamp = has_preamp ? o.Get ("preamp").ToNumber ().DoubleValue () : 0;
    std::vector<double> bands;
    if (o.Get ("bands").IsArray ())
    {
        auto a = o.Get ("bands").As<Napi::Array> ();
        for (uint32_t i = 0; i < a.Length () && i < AUD_EQ_NBANDS; i++)
            bands.push_back (a.Get (i).ToNumber ().DoubleValue ());
    }
    return call (info.Env (), [active, has_preamp, preamp, bands] () {
        if (active >= 0)
            aud_set_bool ("equalizer_active", active);
        if (has_preamp)
            aud_set_double ("equalizer_preamp", std::clamp (preamp, (double) -AUD_EQ_MAX_GAIN, (double) AUD_EQ_MAX_GAIN));
        if (bands.size () == AUD_EQ_NBANDS)
        {
            double values[AUD_EQ_NBANDS];
            for (int i = 0; i < AUD_EQ_NBANDS; i++)
                values[i] = std::clamp (bands[i], (double) -AUD_EQ_MAX_GAIN, (double) AUD_EQ_MAX_GAIN);
            aud_eq_set_bands (values);
        }
        return undefined_result ();
    });
}

// getEqPresets(): Promise<{ name, preamp, bands }[]> from eq.preset
// (user copy, else the shipped defaults).
Napi::Value GetEqPresets (const Napi::CallbackInfo & info)
{
    return call (info.Env (), [] () {
        std::string json = "[";
        auto presets = aud_eq_read_presets ("eq.preset");
        for (int i = 0; i < presets.len (); i++)
        {
            json += i ? ",{\"name\":" : "{\"name\":";
            json_str (json, presets[i].name);
            json += ",\"preamp\":" + json_num (presets[i].preamp) + ",\"bands\":[";
            for (int b = 0; b < AUD_EQ_NBANDS; b++)
                json += (b ? "," : "") + json_num (presets[i].bands[b]);
            json += "]}";
        }
        return json_result (json + ']');
    });
}

// saveEqPresets(presets): replaces the user's eq.preset.
Napi::Value SaveEqPresets (const Napi::CallbackInfo & info)
{
    struct Preset { std::string name; double preamp; double bands[AUD_EQ_NBANDS]; };
    std::vector<Preset> list;
    if (info.Length () > 0 && info[0].IsArray ())
    {
        auto a = info[0].As<Napi::Array> ();
        for (uint32_t i = 0; i < a.Length (); i++)
        {
            auto o = a.Get (i).ToObject ();
            Preset p {o.Get ("name").ToString ().Utf8Value (), o.Get ("preamp").ToNumber ().DoubleValue (), {}};
            auto bands = o.Get ("bands");
            for (int b = 0; b < AUD_EQ_NBANDS; b++)
                p.bands[b] = bands.IsArray () ? bands.As<Napi::Array> ().Get (b).ToNumber ().DoubleValue () : 0;
            list.push_back (p);
        }
    }
    return call (info.Env (), [list] () {
        Index<EqualizerPreset> presets;
        for (auto & p : list)
        {
            EqualizerPreset & e = presets.append ();
            e.name = String (p.name.c_str ());
            e.preamp = p.preamp;
            for (int b = 0; b < AUD_EQ_NBANDS; b++)
                e.bands[b] = p.bands[b];
        }
        bool ok = aud_eq_write_presets (presets, "eq.preset");
        return [ok] (Napi::Env env) -> Napi::Value { return Napi::Boolean::New (env, ok); };
    });
}

// visEnable(on): start/stop streaming "vis" events.
Napi::Value VisEnable (const Napi::CallbackInfo & info)
{
    bool on = info.Length () > 0 && info[0].ToBoolean ().Value ();
    return call (info.Env (), [on] () {
        on ? vis_start () : vis_stop ();
        return undefined_result ();
    });
}

// command(name, arg?): Promise<boolean>; see run_command().
Napi::Value Command (const Napi::CallbackInfo & info)
{
    std::string name = info.Length () > 0 ? info[0].ToString ().Utf8Value () : "";
    std::string arg = (info.Length () > 1 && info[1].IsString ()) ? info[1].As<Napi::String> ().Utf8Value () : "";
    return call (info.Env (), [name, arg] () {
        bool ok = run_command (name, arg);
        return [ok] (Napi::Env env) -> Napi::Value { return Napi::Boolean::New (env, ok); };
    });
}

Napi::Object InitModule (Napi::Env env, Napi::Object exports)
{
    // If the process exits without shutdown() (e.g. Electron's app.exit()
    // skips will-quit), let the engine thread die with it instead of
    // std::terminate() destroying a joinable thread.
    std::atexit ([] () {
        if (engine.joinable ())
            engine.detach ();
    });

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
    exports.Set ("open", Napi::Function::New (env, Open));
    exports.Set ("insert", Napi::Function::New (env, Insert));
    exports.Set ("playLive", Napi::Function::New (env, PlayLive));
    exports.Set ("stopLive", Napi::Function::New (env, StopLive));
    exports.Set ("clear", Napi::Function::New (env, Clear));
    exports.Set ("getPlaylist", Napi::Function::New (env, GetPlaylist));
    exports.Set ("getState", Napi::Function::New (env, GetState));
    exports.Set ("listPlugins", Napi::Function::New (env, ListPlugins));
    exports.Set ("getConfig", Napi::Function::New (env, GetConfig));
    exports.Set ("setConfig", Napi::Function::New (env, SetConfig));
    exports.Set ("enablePlugin", Napi::Function::New (env, EnablePlugin));
    exports.Set ("pluginAbout", Napi::Function::New (env, PluginAbout));
    exports.Set ("openPrefs", Napi::Function::New (env, OpenPrefs));
    exports.Set ("prefsGet", Napi::Function::New (env, PrefsGet));
    exports.Set ("prefsSet", Napi::Function::New (env, PrefsSet));
    exports.Set ("prefsButton", Napi::Function::New (env, PrefsButton));
    exports.Set ("prefsApply", Napi::Function::New (env, PrefsApply));
    exports.Set ("closePrefs", Napi::Function::New (env, ClosePrefs));
    exports.Set ("getEqualizer", Napi::Function::New (env, GetEqualizer));
    exports.Set ("setEqualizer", Napi::Function::New (env, SetEqualizer));
    exports.Set ("getEqPresets", Napi::Function::New (env, GetEqPresets));
    exports.Set ("saveEqPresets", Napi::Function::New (env, SaveEqPresets));
    exports.Set ("visEnable", Napi::Function::New (env, VisEnable));
    exports.Set ("command", Napi::Function::New (env, Command));
    return exports;
}

} // namespace

NODE_API_MODULE (audcore, InitModule)
