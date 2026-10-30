#!/usr/bin/env python3
"""Makes the staged engine self-contained (macOS).

Usage: bundle-dylibs.py <ElectronPlayer.app/Contents>

Every Mach-O file under Contents/Frameworks/engine (libaudcore, plugins,
the native addon) is scanned for the libraries it links. Non-system
libraries outside the bundle (Homebrew's ffmpeg, flac, glib, ...) are copied
into Frameworks/engine/deps, recursively. Every reference is then rewritten
to @executable_path/../<path inside Contents>, absolute LC_RPATHs are
removed, and each modified file is re-signed ad hoc (editing a Mach-O
invalidates its signature).

@executable_path is Contents/MacOS for the Electron main process, which is
the only process that loads the engine.
"""
import os
import re
import shutil
import subprocess
import sys

SYSTEM = ('/usr/lib/', '/System/')


def run(*args: str) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def is_macho(path: str) -> bool:
    with open(path, 'rb') as f:
        magic = f.read(4)
    return magic in (b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca')


def install_id(path: str) -> str | None:
    lines = run('otool', '-D', path).splitlines()
    return lines[1].strip() if len(lines) > 1 else None


def linked(path: str) -> list[str]:
    own = install_id(path)
    deps = []
    for line in run('otool', '-L', path).splitlines()[1:]:
        name = line.strip().split(' (compatibility')[0].strip()
        if name and name != own:
            deps.append(name)
    return deps


def rpaths(path: str) -> list[str]:
    return re.findall(r'cmd LC_RPATH\n\s+cmdsize \d+\n\s+path (.+?) \(offset', run('otool', '-l', path))


def resolve(dep: str, referrer_original: str) -> str | None:
    """Real path of a linked library, or None if it is a system library."""
    if dep.startswith(SYSTEM):
        return None
    base = os.path.dirname(referrer_original)
    if dep.startswith('@loader_path/'):
        candidate = os.path.join(base, dep[len('@loader_path/'):])
    elif dep.startswith('@rpath/'):
        rest = dep[len('@rpath/'):]
        candidate = None
        for rp in rpaths(referrer_original):
            rp = rp.replace('@loader_path', base)
            if os.path.exists(os.path.join(rp, rest)):
                candidate = os.path.join(rp, rest)
                break
        if candidate is None:
            raise SystemExit(f'cannot resolve {dep} for {referrer_original}')
    elif dep.startswith('@'):
        raise SystemExit(f'unsupported reference {dep} in {referrer_original}')
    else:
        candidate = dep
    real = os.path.realpath(candidate)
    if not os.path.exists(real):
        raise SystemExit(f'missing {dep} (needed by {referrer_original})')
    return real


def main() -> None:
    contents = os.path.realpath(sys.argv[1])
    engine = os.path.join(contents, 'Frameworks', 'engine')
    deps_dir = os.path.join(engine, 'deps')
    os.makedirs(deps_dir, exist_ok=True)

    def ref(path: str) -> str:
        return '@executable_path/../' + os.path.relpath(path, contents)

    placed: dict[str, str] = {}  # real source path -> path inside the bundle
    originals: dict[str, str] = {}  # path inside the bundle -> where it came from
    queue: list[str] = []

    for dirpath, _, files in os.walk(engine):
        for name in files:
            path = os.path.join(dirpath, name)
            if not os.path.islink(path) and is_macho(path):
                real = os.path.realpath(path)
                placed[real] = path
                originals[path] = real
                queue.append(path)

    changes: dict[str, list[tuple[str, str]]] = {}
    while queue:
        path = queue.pop()
        changes[path] = []
        for dep in linked(path):
            real = resolve(dep, originals[path])
            if real is None:
                continue
            # The engine's own libraries are already in the bundle: link those,
            # even from a file built against another copy (the native addon
            # links the development libaudcore). Two libaudcores in one
            # process would be two engines.
            bundled = os.path.join(engine, os.path.basename(dep))
            if real not in placed and os.path.isfile(bundled) and not os.path.islink(bundled):
                real = os.path.realpath(bundled)
            if real not in placed:
                if real.startswith(contents + os.sep):
                    placed[real] = real  # already inside the bundle
                else:
                    target = os.path.join(deps_dir, os.path.basename(dep))
                    if os.path.exists(target):  # same name from elsewhere
                        target = os.path.join(deps_dir, os.path.basename(real))
                    shutil.copy2(real, target)
                    os.chmod(target, 0o755)
                    placed[real] = target
                    originals[target] = real
                    queue.append(target)
            changes[path].append((dep, ref(placed[real])))

    for path, edits in changes.items():
        args = []
        if install_id(path):
            args += ['-id', ref(path)]
        for old, new in edits:
            if old != new:
                args += ['-change', old, new]
        for rp in rpaths(path):
            if not rp.startswith('@'):
                args += ['-delete_rpath', rp]
        if args:
            subprocess.run(['install_name_tool', *args, path], check=True, capture_output=True)
        subprocess.run(['codesign', '--force', '--sign', '-', '--timestamp=none', path], check=True, capture_output=True)

    # Nothing may still point outside the bundle.
    leaks = []
    for path in changes:
        for dep in linked(path):
            if not dep.startswith(SYSTEM) and not dep.startswith('@executable_path/../'):
                leaks.append(f'{os.path.relpath(path, contents)} -> {dep}')
        for rp in rpaths(path):
            if not rp.startswith('@'):
                leaks.append(f'{os.path.relpath(path, contents)} rpath {rp}')
    if leaks:
        raise SystemExit('references outside the bundle:\n  ' + '\n  '.join(leaks))

    copied = [p for p in changes if p.startswith(deps_dir)]
    size = sum(os.path.getsize(p) for p in copied)
    print(f'{len(changes)} files repointed; {len(copied)} libraries copied into deps ({size / 1e6:.0f} MB)')


if __name__ == '__main__':
    main()
