/**
 * Bundles the extension into dist/, which is what Chrome loads.
 *
 * Three entry points with three different module formats, because MV3 is picky:
 *   background  ESM  — service workers may be modules
 *   popup       ESM  — an ordinary extension page
 *   content     IIFE — content scripts may NOT be modules, so this one is
 *                      bundled flat and self-invoking
 *
 * Bundling is what lets the extension import @seal/shared and therefore run the
 * exact canonicalization and Ed25519 code the server and the payment rail run.
 * A second, hand-rolled implementation of either would be a bug waiting to
 * happen — signatures that verify in one place and not another.
 */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// Static assets are copied verbatim; the manifest lives beside them so that
// "Load unpacked → dist" is the whole install story.
for (const dir of ['public', 'icons']) {
  const from = path.join(root, dir);
  if (fs.existsSync(from)) fs.cpSync(from, dir === 'icons' ? path.join(out, 'icons') : out, { recursive: true });
}

const shared = {
  bundle: true,
  target: 'chrome114',
  logLevel: 'info',
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
};

const builds = [
  { entryPoints: [path.join(root, 'src/background.ts')], outfile: path.join(out, 'background.js'), format: 'esm' },
  { entryPoints: [path.join(root, 'src/popup.ts')], outfile: path.join(out, 'popup.js'), format: 'esm' },
  { entryPoints: [path.join(root, 'src/content.ts')], outfile: path.join(out, 'content.js'), format: 'iife' },
];

function printLoadInstructions() {
  // Chrome wants the folder containing manifest.json, which is the build
  // output and not the package root. Printing the absolute path saves
  // everyone the "Manifest file is missing or unreadable" detour.
  console.log("");
  console.log("[seal-ext] Load it in Chrome:");
  console.log("  1. chrome://extensions  ->  enable Developer mode");
  console.log("  2. Load unpacked  ->  select EXACTLY this folder:");
  console.log("");
  console.log("     " + out);
  console.log("");
  console.log("  (the package root has no manifest; the built dist/ folder does)");
  console.log("");
}

if (watch) {
  for (const b of builds) {
    const ctx = await esbuild.context({ ...shared, ...b });
    await ctx.watch();
  }
  printLoadInstructions();
  console.log('[seal-ext] watching for changes');
} else {
  await Promise.all(builds.map((b) => esbuild.build({ ...shared, ...b })));
  printLoadInstructions();
}
