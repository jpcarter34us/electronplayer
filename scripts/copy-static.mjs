// Copies non-TS renderer assets (HTML, CSS) into dist/.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';

mkdirSync('dist/renderer', { recursive: true });
for (const f of readdirSync('src/renderer')) {
  if (/\.(html|css)$/.test(f)) cpSync(`src/renderer/${f}`, `dist/renderer/${f}`);
}
