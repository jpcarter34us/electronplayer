// Windows: the addon imports N-API from "node.exe", delay-loaded. Electron's
// executable (ElectronPlayer.exe) exports N-API itself, so point that import
// at the running executable. node-gyp ships a hook like this, but only for
// MSVC; this one builds with MinGW (GCC or clang), which the engine uses.
#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <delayimp.h>
#include <string.h>

static FARPROC WINAPI load_exe_hook(unsigned event, PDelayLoadInfo info) {
  if (event != dliNotePreLoadLibrary || _stricmp(info->szDll, "node.exe") != 0)
    return nullptr;
  return reinterpret_cast<FARPROC>(GetModuleHandle(nullptr));
}

PfnDliHook __pfnDliNotifyHook2 = load_exe_hook;
#endif
