#!/usr/bin/env python3
"""Fetches MSYS2's prebuilt Windows libraries for cross-building the engine.

Usage: fetch-msys2-deps.py clang64|clangarm64 <dest>

MSYS2's clang64 (x64) and clangarm64 (arm64) repositories are built with
the same toolchain as llvm-mingw (clang, libc++, UCRT), so the engine,
cross-compiled with llvm-mingw, links against them directly. Each package
the plugins use, plus its runtime dependencies from the repository
database, is downloaded (checksums verified) and unpacked into <dest>, so
files land in <dest>/<repo>/{bin,include,lib}. Toolchain runtime packages
(libc++, winpthreads, ...) are left out: llvm-mingw provides those.
FFmpeg is built from source instead (scripts/build-engine-other.sh).
Re-running only fetches what is missing.
"""
import hashlib
import io
import os
import re
import subprocess
import sys
import tarfile
import urllib.request

PACKAGES = [
    'glib2', 'gettext-runtime', 'flac', 'libvorbis', 'libogg', 'opus', 'opusfile',
    'mpg123', 'lame', 'libsndfile', 'wavpack', 'libopenmpt', 'libmodplug',
    'libsidplayfp', 'fluidsynth', 'faad2', 'libcue', 'neon', 'libsoxr',
    'libsamplerate', 'libbs2b', 'libxml2', 'curl',
]
# Provided by llvm-mingw, or never needed at run time.
SKIP = re.compile(r'^(crt|headers|libc\+\+|libunwind|libwinpthread|winpthreads|compiler-rt|'
                  r'clang|llvm|lld|gcc|python|tcl|tk|cc-libs|ca-certificates|pkgconf|gettext-tools)(-git)?$')
MIRROR = 'https://mirror.msys2.org/mingw/{repo}/'


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url) as r:
        return r.read()


def read_db(repo: str) -> dict:
    """name -> {filename, sha256, depends}, also indexed by what each provides."""
    raw = subprocess.run(['zstd', '-dc'], input=fetch(MIRROR.format(repo=repo) + f'{repo}.db'),
                         capture_output=True, check=True).stdout
    db = {}
    with tarfile.open(fileobj=io.BytesIO(raw)) as tar:
        for member in tar:
            if not member.name.endswith('/desc'):
                continue
            fields, key = {}, None
            for line in tar.extractfile(member).read().decode().splitlines():
                if line.startswith('%') and line.endswith('%'):
                    key = line.strip('%')
                    fields[key] = []
                elif line and key:
                    fields[key].append(line)
            entry = {
                'filename': fields['FILENAME'][0],
                'sha256': fields['SHA256SUM'][0],
                'depends': [re.split(r'[<>=]', d)[0] for d in fields.get('DEPENDS', [])],
            }
            db[fields['NAME'][0]] = entry
            for provided in fields.get('PROVIDES', []):
                db.setdefault(re.split(r'[<>=]', provided)[0], entry)
    return db


def main() -> None:
    repo, dest = sys.argv[1], sys.argv[2]
    prefix = {'clang64': 'mingw-w64-clang-x86_64-', 'clangarm64': 'mingw-w64-clang-aarch64-'}[repo]
    os.makedirs(dest, exist_ok=True)
    db = read_db(repo)

    wanted, queue = {}, [prefix + p for p in PACKAGES]
    while queue:
        name = queue.pop()
        short = name[len(prefix):] if name.startswith(prefix) else name
        if name in wanted or SKIP.match(short):
            continue
        if name not in db:
            if short in PACKAGES:
                print(f'not in {repo}: {short}', file=sys.stderr)
            continue
        wanted[name] = db[name]
        queue += db[name]['depends']

    stamp_dir = os.path.join(dest, '.fetched')
    os.makedirs(stamp_dir, exist_ok=True)
    for entry in sorted({e['filename']: e for e in wanted.values()}.values(), key=lambda e: e['filename']):
        stamp = os.path.join(stamp_dir, entry['filename'])
        if os.path.exists(stamp):
            continue
        data = fetch(MIRROR.format(repo=repo) + entry['filename'])
        if hashlib.sha256(data).hexdigest() != entry['sha256']:
            sys.exit(f'checksum mismatch: {entry["filename"]}')
        tar_bytes = subprocess.run(['zstd', '-dc'], input=data, capture_output=True, check=True).stdout
        with tarfile.open(fileobj=io.BytesIO(tar_bytes)) as tar:
            members = [m for m in tar if not m.name.startswith('.')]
            # Debian 12's Python 3.11.2 predates extraction filters.
            tar.extractall(dest, members=members, **({'filter': 'tar'} if hasattr(tarfile, 'tar_filter') else {}))
        open(stamp, 'w').close()
        print(f'fetched {entry["filename"]}')
    print(f'{len(wanted)} packages in {dest}')


main()
