#!/usr/bin/env python3
"""Copies the libraries the Linux or Windows engine needs into its folder.

Usage: bundle-libs-other.py <app>/engine <target> <deps>

Every binary in the engine folder (libaudcore, plugins, the addon) is
scanned for the libraries it links (readelf for ELF, llvm-objdump for PE);
each one found in the build's library folders is copied next to libaudcore,
and so on recursively. Libraries that are not found there belong to the
system (Windows DLLs, glibc).

Linux: libraries every desktop already has, and that Electron itself loads
(glib, the sound servers, GnuTLS, X11, ...), are left to the system, so the
engine uses the same copy as the rest of the process. RUNPATHs are set so
everything resolves inside the engine folder. Windows: plugins find their
DLLs through the folder the addon adds to the DLL search path.
"""
import os
import re
import shutil
import subprocess
import sys

engine, target, deps = sys.argv[1], sys.argv[2], sys.argv[3]
windows = target.startswith('win-')
arm = target.endswith('arm64')

LINUX_SYSTEM = re.compile(
    r'^(ld-linux.*|libc|libm|libdl|libmvec|libpthread|librt|libresolv|libutil|libstdc\+\+|libgcc_s|'
    r'libglib-2\.0|libgobject-2\.0|libgio-2\.0|libgmodule-2\.0|libgthread-2\.0|libffi|libpcre2-8|'
    r'libmount|libblkid|libselinux|libz|libexpat|libuuid|libsystemd|libudev|libdbus-1|'
    r'libasound|libpulse.*|libpipewire-0\.3|libjack.*|'
    # (libunistring and libidn2 are bundled even so: their sonames differ
    # between distributions, e.g. Ubuntu 24.04 has libunistring.so.5.)
    r'libgnutls|libnettle|libhogweed|libgmp|libp11-kit|libtasn1|'
    r'libX.*|libxcb.*|libwayland.*|libGL.*|libEGL|libdrm|libgbm)\.so.*$')

if windows:
    repo = 'clangarm64' if arm else 'clang64'
    triple = ('aarch64' if arm else 'x86_64') + '-w64-mingw32'
    search = [os.path.join(deps, 'ffmpeg', 'bin'), os.path.join(deps, 'msys2', repo, 'bin'),
              f'/opt/llvm-mingw/{triple}/bin']
else:
    triple = 'aarch64-linux-gnu' if arm else 'x86_64-linux-gnu'
    search = [os.path.join(deps, 'ffmpeg', 'lib'), f'/usr/lib/{triple}', f'/lib/{triple}']
    # libjack etc. live in subfolders on some Debian versions; pulse keeps a private lib.
    search += [os.path.join(f'/usr/lib/{triple}', d) for d in ('pulseaudio',)]


def needed(path: str) -> list[str]:
    if windows:
        out = subprocess.run(['llvm-objdump', '-p', path], capture_output=True, text=True).stdout
        return re.findall(r'DLL Name: (\S+)', out)
    out = subprocess.run(['readelf', '-d', path], capture_output=True, text=True).stdout
    return re.findall(r'\(NEEDED\)\s+Shared library: \[([^\]]+)\]', out)


def is_binary(path: str) -> bool:
    if os.path.islink(path) or not os.path.isfile(path):
        return False
    with open(path, 'rb') as f:
        magic = f.read(4)
    return magic[:2] == b'MZ' if windows else magic == b'\x7fELF'


def find(name: str) -> str | None:
    if not windows and LINUX_SYSTEM.match(name):
        return None
    for d in search:
        candidate = os.path.join(d, name)
        if os.path.exists(candidate):
            return os.path.realpath(candidate)
        if windows and os.path.isdir(d):  # DLL names are case-insensitive
            for f in os.listdir(d):
                if f.lower() == name.lower():
                    return os.path.join(d, f)
    return None


# Meson installs libaudcore.so.5.x with .so.5 and .so symlinks. Keep one real
# file under the name binaries ask for (the soname); drop the rest.
real_files = [os.path.join(engine, f) for f in os.listdir(engine) if is_binary(os.path.join(engine, f))]
all_real = [os.path.join(dp, f) for dp, _, fs in os.walk(engine) for f in fs if is_binary(os.path.join(dp, f))]
wanted = {n for b in all_real for n in needed(b)}
for f in sorted(os.listdir(engine)):
    path = os.path.join(engine, f)
    if not os.path.islink(path):
        continue
    real = os.path.realpath(path)
    os.unlink(path)
    if f in wanted and os.path.exists(real):
        shutil.move(real, path)
for path in real_files:
    if os.path.exists(path) and re.search(r'\.so\.\d+\.\d+', os.path.basename(path)):
        os.remove(path)  # a versioned file nothing names directly

binaries = [os.path.join(dp, f) for dp, _, fs in os.walk(engine) for f in fs if is_binary(os.path.join(dp, f))]
present = {f.lower() if windows else f for f in os.listdir(engine)}
queue, copied = list(binaries), []
while queue:
    for name in needed(queue.pop()):
        key = name.lower() if windows else name
        if key in present:
            continue
        source = find(name)
        if not source:
            continue
        dest = os.path.join(engine, name)
        shutil.copy2(source, dest)
        os.chmod(dest, 0o755)
        present.add(key)
        copied.append(name)
        queue.append(dest)

strip = 'llvm-strip' if windows else ('aarch64-linux-gnu-strip' if arm else 'strip')
for dp, _, fs in os.walk(engine):
    for f in fs:
        path = os.path.join(dp, f)
        if not is_binary(path):
            continue
        subprocess.run([strip, '--strip-unneeded', path], check=True)
        if not windows:
            rel = os.path.relpath(engine, dp)
            rpath = '$ORIGIN' if rel == '.' else f'$ORIGIN/{rel}'
            subprocess.run(['patchelf', '--set-rpath', rpath, path], check=True)

# Anything still unresolved must be a system library; list it for review.
unresolved = set()
for dp, _, fs in os.walk(engine):
    for f in fs:
        path = os.path.join(dp, f)
        if is_binary(path):
            for name in needed(path):
                key = name.lower() if windows else name
                if key not in present:
                    unresolved.add(name)
print(f'Bundled {len(copied)} libraries into {engine}')
print('Left to the system: ' + ' '.join(sorted(unresolved)))
