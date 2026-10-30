// Bundles renderer entry points that import npm packages (bare specifiers
// a file:// page can't resolve). Everything else is compiled by tsc alone.
import { build } from 'esbuild';

await build({
  entryPoints: { sendspin: 'src/renderer/sendspin-host.ts' },
  outdir: 'dist/renderer',
  bundle: true,
  format: 'iife',
  target: 'chrome140',
  sourcemap: true,
  logLevel: 'warning',
});
