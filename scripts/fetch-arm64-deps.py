#!/usr/bin/env python3
"""Fetches Apple Silicon (arm64) Homebrew libraries for cross-building the
engine on an Intel Mac.

Usage: fetch-arm64-deps.py <dest>

Homebrew installs only this Mac's architecture, so the arm64 build links
against Homebrew's published arm64 bottles instead: each formula the engine
uses, plus its runtime dependencies, is downloaded from Homebrew's registry
(checksums verified), unpacked into <dest>/Cellar with <dest>/opt, lib and include links,
and relocated to <dest> (the placeholders Homebrew writes into bottles are
replaced, as `brew install` does on pour). Nothing is installed into
Homebrew itself. Re-running only fetches what is missing.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
import urllib.request

# What audacious-plugins links on macOS (the same set the x64 build picks up
# from Homebrew); runtime dependencies are added from Homebrew's metadata.
FORMULAE = [
    'glib', 'gettext', 'ffmpeg', 'flac', 'libvorbis', 'libogg', 'opus', 'opusfile',
    'mpg123', 'lame', 'libsndfile', 'wavpack', 'libopenmpt', 'libmodplug',
    'libsidplayfp', 'fluid-synth', 'faad2', 'libcue', 'neon', 'libsoxr',
    'libsamplerate', 'libbs2b', 'portaudio', 'sdl3',
]
# Oldest first: the app then runs on more macOS versions (bottles carry the
# macOS they were built for as their minimum).
TAGS = ('arm64_sonoma', 'arm64_sequoia', 'arm64_tahoe')
API = 'https://formulae.brew.sh/api/formula/{}.json'
PLACEHOLDERS = ('@@HOMEBREW_PREFIX@@', '@@HOMEBREW_CELLAR@@')


def info(name: str) -> dict:
    with urllib.request.urlopen(API.format(name)) as r:
        return json.load(r)


def closure(names: list[str]) -> dict[str, dict]:
    found: dict[str, dict] = {}
    todo = list(names)
    while todo:
        name = todo.pop()
        if name in found:
            continue
        found[name] = info(name)
        todo += found[name].get('dependencies', [])
    return found


def bottle(meta: dict) -> tuple[str, str]:
    files = meta['bottle']['stable']['files']
    for tag in TAGS:
        if tag in files:
            return files[tag]['url'], files[tag]['sha256']
    if 'all' in files:
        return files['all']['url'], files['all']['sha256']
    raise SystemExit(f"no arm64 macOS bottle for {meta['name']}")


def download(url: str, sha: str, path: str) -> None:
    if os.path.exists(path) and hashlib.sha256(open(path, 'rb').read()).hexdigest() == sha:
        return
    # Homebrew's registry takes an anonymous token, as `brew fetch` sends.
    subprocess.run(['curl', '-fsSL', '-H', 'Authorization: Bearer QQ==', '-o', path, url], check=True)
    if hashlib.sha256(open(path, 'rb').read()).hexdigest() != sha:
        raise SystemExit(f'checksum mismatch for {url}')


def is_macho(path: str) -> bool:
    with open(path, 'rb') as f:
        return f.read(4) == b'\xcf\xfa\xed\xfe'  # thin 64-bit (bottles are single-arch)


def relocate(keg: str, dest: str) -> None:
    def fix(s: str) -> str:
        s = s.replace('@@HOMEBREW_CELLAR@@', f'{dest}/Cellar').replace('@@HOMEBREW_PREFIX@@', dest)
        return re.sub(r'^/opt/homebrew(?=/)', dest, s)

    for dirpath, _, files in os.walk(keg):
        for name in files:
            path = os.path.join(dirpath, name)
            if os.path.islink(path):
                continue
            os.chmod(path, os.stat(path).st_mode | 0o200)
            if is_macho(path):
                out = subprocess.run(['otool', '-l', path], check=True, capture_output=True, text=True).stdout
                args = []
                for cmd, value in re.findall(r'cmd (LC_ID_DYLIB|LC_LOAD_DYLIB|LC_LOAD_WEAK_DYLIB|LC_REEXPORT_DYLIB|LC_RPATH)\n'
                                             r'\s+cmdsize \d+\n\s+(?:name|path) (.+?) \(offset', out):
                    if fix(value) == value:
                        continue
                    if cmd == 'LC_ID_DYLIB':
                        args += ['-id', fix(value)]
                    elif cmd == 'LC_RPATH':
                        args += ['-rpath', value, fix(value)]
                    else:
                        args += ['-change', value, fix(value)]
                if args:
                    subprocess.run(['install_name_tool', *args, path], check=True, capture_output=True)
                    subprocess.run(['codesign', '--force', '--sign', '-', path], check=True, capture_output=True)
            elif name.endswith(('.pc', '.la', '-config')) or '/pkgconfig/' in path:
                with open(path, 'rb') as f:
                    text = f.read()
                if any(p.encode() in text for p in PLACEHOLDERS) or b'/opt/homebrew/' in text:
                    text = text.decode('utf-8', 'surrogateescape')
                    text = text.replace('@@HOMEBREW_CELLAR@@', f'{dest}/Cellar').replace('@@HOMEBREW_PREFIX@@', dest)
                    text = text.replace('/opt/homebrew/', f'{dest}/')
                    with open(path, 'wb') as f:
                        f.write(text.encode('utf-8', 'surrogateescape'))


def main() -> None:
    dest = os.path.abspath(sys.argv[1])
    cache = os.path.join(dest, 'downloads')
    for d in (cache, os.path.join(dest, 'Cellar'), os.path.join(dest, 'opt')):
        os.makedirs(d, exist_ok=True)

    formulae = closure(FORMULAE)
    for name, meta in sorted(formulae.items()):
        version = meta['versions']['stable']
        if meta.get('revision'):
            version += f"_{meta['revision']}"
        keg = os.path.join(dest, 'Cellar', name, version)
        opt = os.path.join(dest, 'opt', name)
        if not os.path.isdir(keg):
            url, sha = bottle(meta)
            archive = os.path.join(cache, f'{name}-{version}.tar.gz')
            download(url, sha, archive)
            with tarfile.open(archive) as tar:
                tar.extractall(os.path.join(dest, 'Cellar'), filter='tar')
            if not os.path.isdir(keg):  # bottle rebuilds can use another folder name
                keg = os.path.join(dest, 'Cellar', name, sorted(os.listdir(os.path.join(dest, 'Cellar', name)))[-1])
            relocate(keg, dest)
            print(f'  {name} {version}')
        if os.path.lexists(opt):
            os.remove(opt)
        os.symlink(os.path.relpath(keg, os.path.dirname(opt)), opt)
    # One lib/ and include/ for all, as `brew link` makes, so libraries found
    # without pkg-config (libintl) come from here before /usr/local.
    for sub in ('lib', 'include'):
        merged = os.path.join(dest, sub)
        os.makedirs(merged, exist_ok=True)
        for name in sorted(formulae):
            src = os.path.join(dest, 'opt', name, sub)
            if not os.path.isdir(src):
                continue
            for entry in os.listdir(src):
                link = os.path.join(merged, entry)
                if entry != 'pkgconfig' and not os.path.lexists(link):
                    os.symlink(os.path.relpath(os.path.join(src, entry), merged), link)
    print(f'{len(formulae)} arm64 formulae in {dest}')


if __name__ == '__main__':
    main()
