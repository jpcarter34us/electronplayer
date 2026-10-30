// Renders resources/icon.svg to resources/icon.png (1024 px, the dock icon
// when running unpackaged) and resources/icon.icns (the app icon), using
// Electron's own Chromium so no SVG tools need installing.
//
// Usage: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'resources/icon.svg'), 'utf8');
// iconutil wants these names; each size also has a @2x twice as large.
const SIZES = [16, 32, 128, 256, 512];

app.dock?.hide();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<body></body>');
  const render = (size) => win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = ${size};
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, ${size}, ${size});
      resolve(canvas.toDataURL('image/png').split(',')[1]);
    };
    img.onerror = () => reject(new Error('SVG did not load'));
    img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
  })`);

  const set = fs.mkdtempSync(path.join(os.tmpdir(), 'icon-')) + '/icon.iconset';
  fs.mkdirSync(set);
  for (const size of SIZES) {
    fs.writeFileSync(`${set}/icon_${size}x${size}.png`, Buffer.from(await render(size), 'base64'));
    fs.writeFileSync(`${set}/icon_${size}x${size}@2x.png`, Buffer.from(await render(size * 2), 'base64'));
  }
  fs.copyFileSync(`${set}/icon_512x512@2x.png`, path.join(root, 'resources/icon.png'));
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(root, 'resources/icon.icns')]);
  fs.rmSync(path.dirname(set), { recursive: true });
  console.log('Wrote resources/icon.png and resources/icon.icns');
  app.quit();
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
