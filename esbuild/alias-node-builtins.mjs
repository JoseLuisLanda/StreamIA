/**
 * esbuild plugin: resolve the Node built-ins "fs" and "path" to an EMPTY browser
 * stub in EVERY output bundle -- including the Piper web worker.
 *
 * Why: @diffusionstudio/vits-web -> onnxruntime-web reference "fs"/"path" in
 * Node-only code paths that never run in the browser, but the bundler must still
 * resolve the bare specifiers. The previous approach (angular.json
 * externalDependencies + an index.html import map) only fixed the MAIN thread:
 * a module worker does NOT inherit the document import map, so the worker chunk
 * kept bare "fs"/"path" imports and failed to load -> Piper fell back to
 * main-thread synthesis (UI freeze). Aliasing to a real stub makes esbuild bundle
 * an empty module inline in both the main and worker chunks -> no bare specifiers
 * anywhere -> the worker loads.
 *
 * Used via @angular-builders/custom-esbuild "plugins" in angular.json.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const STUB = resolve(here, '../src/shims/node-empty.ts');

export default {
  name: 'alias-node-builtins',
  setup(build) {
    build.onResolve({ filter: /^(fs|path)$/ }, () => ({ path: STUB }));
  },
};
