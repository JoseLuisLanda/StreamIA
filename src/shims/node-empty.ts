/**
 * Empty browser shim for Node built-ins (`fs`, `path`).
 *
 * The Piper TTS dependency (@diffusionstudio/vits-web) ships an emscripten bundle
 * that contains Node-only `require('fs')` / `require('path')` calls inside branches
 * guarded by an ENVIRONMENT_IS_NODE check. Those branches never run in the browser,
 * but the bundler must still RESOLVE the specifiers. tsconfig `paths` maps `fs` and
 * `path` to this empty module so resolution succeeds (build) and there is no bare
 * "fs" import left to fail at runtime.
 */
const empty: any = {};
export default empty;
