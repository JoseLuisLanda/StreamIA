// Empty browser shim for Node built-ins (fs, path) referenced by the Piper TTS
// dependency (@diffusionstudio/vits-web) inside Node-only branches that never run
// in the browser. Mapped here via the import map in index.html.
export default {};
