/**
 * Postinstall patch: make the Piper TTS deps browser-safe for the stock @angular/build
 * (esbuild) bundler -- WITHOUT a custom builder/plugin.
 *
 * @diffusionstudio/vits-web ships an emscripten bundle (piper-*.js) that contains Node-only
 * `require("fs")` / `require("path")` calls inside dead branches guarded by an
 * ENVIRONMENT_IS_NODE check. esbuild (platform: browser) still must RESOLVE those bare
 * specifiers and, with no Node polyfills, fails the build with:
 *   X [ERROR] Could not resolve "fs" / "path" [plugin angular-compiler]
 *
 * The @angular-builders/custom-esbuild alias-plugin approach is dead on Angular 21 (that
 * builder pins @angular/build@^19). The portable fix that works with the STOCK builder is
 * the package's own `browser` field: esbuild honors `browser: { "fs": false, "path": false }`
 * and substitutes an EMPTY module for those imports -- in EVERY chunk, including the Piper
 * web worker. The dead branches never run in the browser, so the empty stub is never called.
 *
 * This script merges (does not clobber) the `browser` map into each dep's package.json. It is
 * idempotent and re-runs on every `npm install` via the "postinstall" script.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TARGETS = ['@diffusionstudio/vits-web', 'onnxruntime-web'];
const BUILTINS = ['fs', 'path'];

for (const name of TARGETS) {
  let pkgPath;
  try {
    pkgPath = require.resolve(`${name}/package.json`);
  } catch {
    console.warn(`[patch-vits-web] ${name} not installed; skipping.`);
    continue;
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  // Only the object form of `browser` is a substitution map. If a package uses the string
  // form (alternate entry point), leave it alone to avoid breaking its browser build.
  if (pkg.browser !== undefined && (typeof pkg.browser !== 'object' || pkg.browser === null)) {
    console.warn(`[patch-vits-web] ${name} has a non-object "browser" field; skipping.`);
    continue;
  }

  const browser = pkg.browser ?? {};
  let changed = false;
  for (const m of BUILTINS) {
    if (browser[m] !== false) { browser[m] = false; changed = true; }
  }

  if (changed) {
    pkg.browser = browser;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`[patch-vits-web] patched "browser" (fs/path -> false) in ${name}.`);
  } else {
    console.log(`[patch-vits-web] ${name} already patched.`);
  }
}
