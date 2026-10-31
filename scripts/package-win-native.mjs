// Builds the Windows package on Windows itself, from PowerShell or cmd,
// without WSL or Docker: npm run dist:win:native. Needs MSYS2
// (winget install MSYS2.MSYS2), which the engine is built in; the script
// installs the MSYS2 packages it needs on first use.
//
//   1. TypeScript and renderer bundles             (npm run build)
//   2. Engine, FFmpeg and native addon             (build-engine-windows.sh, in MSYS2 UCRT64)
//   3. electron-builder packages the installer and .zip
//
// x64 only: MSYS2's GCC environment has no arm64 compiler. The x64 build
// also runs on Windows on Arm, emulated.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fail = (msg) => { console.error(msg); process.exit(1); };
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
  if (r.error) fail(r.error.message);
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (process.platform !== 'win32') fail('This builds on Windows. Elsewhere, use npm run dist:win (Docker).');
const msys = process.env.MSYS2_ROOT ?? 'C:\\msys64';
const bash = join(msys, 'usr', 'bin', 'bash.exe');
if (!existsSync(bash)) {
  fail(`MSYS2 was not found in ${msys}. Install it with:\n  winget install MSYS2.MSYS2\n` +
       'or set MSYS2_ROOT to where it is installed.');
}
for (const name of ['audacious', 'audacious-plugins']) {
  if (!existsSync(join(root, 'vendor', name, 'meson.build'))) fail('The Audacious sources are missing. Run:\n  git submodule update --init --depth 1');
}
const require = createRequire(join(root, 'native', 'package.json'));
let napiInclude;
try {
  napiInclude = resolve(require('node-addon-api').include_dir);  // relative to the cwd
} catch {
  fail('native/node_modules is missing. Run:\n  cd native; npm install --ignore-scripts; cd ..');
}
const electron = createRequire(join(root, 'package.json'))('electron/package.json').version;

// npm's .cmd shims need a shell; pass one command string so nothing is
// re-split.
run('npm run build', [], { shell: true });

// Run the engine build from a copy with LF line endings: in a checkout made
// before .gitattributes, Git for Windows wrote the script with CRLF.
mkdirSync(join(root, 'build'), { recursive: true });
const script = join(root, 'build', 'build-engine-windows.sh');
writeFileSync(script, readFileSync(join(root, 'scripts', 'build-engine-windows.sh'), 'utf8').replace(/\r\n/g, '\n'));
run(bash, ['-l', script.replace(/\\/g, '/')], {
  env: {
    ...process.env,
    MSYSTEM: 'UCRT64',
    CHERE_INVOKING: '1',
    MSYS2_PATH_TYPE: 'inherit', // keeps Git for Windows on PATH
    EP_ROOT: root.replace(/\\/g, '/'),
    ELECTRON_VERSION: electron,
    NAPI_INC: napiInclude.replace(/\\/g, '/'),
  },
});

run('npx electron-builder --win --x64 --publish never', [], { shell: true });
console.log(`\nDone. The installer and .zip are in ${join(root, 'release')}`);
