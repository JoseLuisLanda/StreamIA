/**
 * Postinstall patch: make @diffusionstudio/vits-web browser-safe for the STOCK
 * @angular/build (esbuild) bundler on Angular 21.
 *
 * Why this exists: the @angular-builders/custom-esbuild alias-plugin approach is dead on
 * Angular 21 (that builder hard-requires @angular/build@^19). vits-web's emscripten bundle
 * (piper-*.js) has Node-only `require("fs")` / `require("path")` calls inside dead
 * ENVIRONMENT_IS_NODE branches. esbuild (platform: browser) still must RESOLVE those bare
 * specifiers; with `externalDependencies` they survive as bare imports that the Piper
 * MODULE WORKER cannot resolve (a module worker does not inherit the page import map) ->
 * the worker fails to load -> Piper falls back to MAIN-THREAD synthesis (UI freeze and the
 * "numThreads is 32 / crossOriginIsolated" warning, since vits-web sets numThreads on the
 * main thread when the worker is down).
 *
 * Fix: rewrite those dead `require("fs"|"path")` calls to an inline empty object `({})` in
 * vits-web's dist, so there is NO bare specifier left for esbuild to resolve in EITHER the
 * main or the worker chunk. The branches never run in the browser, so `({})` is inert. This
 * lets `externalDependencies` be removed -> the worker bundles cleanly -> it loads and runs
 * single-thread synthesis off the main thread. Idempotent (after the rewrite there is
 * nothing left to match) and re-runs on every `npm install` via "postinstall".
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'node_modules', '@diffusionstudio', 'vits-web', 'dist');

function patchDir(dir) {
  let count = 0;
  let entries;
  try { entries = readdirSync(dir); } catch { return 0; }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { count += patchDir(p); continue; }
    if (!/\.(js|mjs|cjs)$/.test(name)) continue;
    const src = readFileSync(p, 'utf8');
    const re = /require\(\s*["'](?:fs|path)["']\s*\)/g;
    if (!re.test(src)) continue;
    writeFileSync(p, src.replace(/require\(\s*["'](?:fs|path)["']\s*\)/g, '({})'));
    count++;
    console.log('[patch-vits-web] stubbed fs/path require in ' + p);
  }
  return count;
}

const n = patchDir(dist);
if (n) console.log('[patch-vits-web] patched ' + n + ' file(s).');
else console.log('[patch-vits-web] nothing to patch (already done or dir missing): ' + dist);
