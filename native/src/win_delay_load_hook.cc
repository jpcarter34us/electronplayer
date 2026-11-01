// Windows only: Node-API functions are imported from "node.exe" (the import
// library's name), but here they live in ElectronPlayer.exe. The addon
// delay-loads that import, and this hook hands the delay-load helper the
// running executable instead, so the calls resolve to whatever program
// loaded the addon.
//
// node-gyp ships the same hook (src/win_delay_load_hook.cc), but compiles it
// only under MSVC (#ifdef _MSC_VER); the Windows engine is built with
// llvm-mingw (scripts/build-engine-other.sh), where it would silently drop out
// and the first Node-API call would crash the app.
#ifdef _WIN32

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <delayimp.h>
#include <string.h>

static FARPROC WINAPI load_exe_hook (unsigned event, DelayLoadInfo * info)
{
    if (event != dliNotePreLoadLibrary || _stricmp (info->szDll, "node.exe") != 0)
        return nullptr;
    return (FARPROC) GetModuleHandleW (nullptr);
}

extern "C" PfnDliHook __pfnDliNotifyHook2 = load_exe_hook;

#endif
