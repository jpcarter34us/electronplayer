# native/: libaudcore bridge

N-API addon (`audcore.node`) that Electron's main process loads to run the real
Audacious engine and its decoder, output, effect, transport and playlist plugins.

```bash
npm run build:audacious             # vendor/ -> vendor/prefix (meson, no GTK/Qt)
(cd native && npm install)
npm run build:native                # builds against Electron's headers
```

Once `native/build/Release/audcore.node` exists, `src/main/native.ts` loads it
starts libaudcore headless on an engine thread, and the renderer switches to
`NativeBackend`. The status bar then reads `libaudcore (plugin API …)`.

Threading: every exported call is queued onto the engine thread (which owns
libaudcore's GLib main loop) and returns a Promise. Engine hooks come back as
`BackendEvent` objects through a single `ThreadSafeFunction`.
