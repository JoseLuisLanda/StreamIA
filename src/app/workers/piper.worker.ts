/// <reference lib="webworker" />
/**
 * Piper TTS synthesis worker: keeps WASM inference (ONNX + espeak phonemizer)
 * off the main thread. Voice models are cached in OPFS (available in workers).
 *
 * SESSION CACHE (quick win): vits-web's predict() re-creates the ONNX
 * InferenceSession from the model bytes on EVERY call — measured as the
 * dominant time-to-first-word cost. Since classes aren't frozen, we wrap
 * ort.InferenceSession.create with a memoized version (keyed by model byte
 * length — one entry per voice, max 2 kept) so each utterance after the first
 * reuses the warm session.
 *
 * Protocol: { id, text, voiceId } -> { id, wav: ArrayBuffer (transferred),
 *            meta: { synthMs, sessionCached } }
 *           progress: { id, progress: 0..1 }  errors: { id, error }
 */
let mod: any = null;
let ortPatched = false;
let lastSessionCached = false;

async function patchOrtSessionCache(): Promise<void> {
    if (ortPatched) return;
    const ort: any = await import('onnxruntime-web');
    const orig = ort.InferenceSession.create.bind(ort.InferenceSession);
    const cache = new Map<number, Promise<any>>();
    ort.InferenceSession.create = (data: any, ...rest: any[]) => {
        if (data instanceof ArrayBuffer && rest.length === 0) {
            const key = data.byteLength;
            const hit = cache.get(key);
            if (hit) { lastSessionCached = true; return hit; }
            lastSessionCached = false;
            const pending = orig(data, ...rest);
            cache.set(key, pending);
            pending.catch(() => cache.delete(key));
            if (cache.size > 2) { const oldest = cache.keys().next().value as number; cache.delete(oldest); }
            return pending;
        }
        lastSessionCached = false;
        return orig(data, ...rest);
    };
    ortPatched = true;
}

self.onmessage = async (e: MessageEvent) => {
    const { id, text, voiceId } = e.data as { id: number; text: string; voiceId: string };
    try {
        await patchOrtSessionCache();
        mod = mod ?? (await import('@diffusionstudio/vits-web'));
        lastSessionCached = true; // create() resets it to false on a real (uncached) build
        const t0 = performance.now();
        const blob: Blob = await mod.predict({ text, voiceId }, (p: any) => {
            if (p?.total) (self as any).postMessage({ id, progress: Math.min(1, p.loaded / p.total) });
        });
        const synthMs = performance.now() - t0;
        const wav = await blob.arrayBuffer();
        (self as any).postMessage({ id, wav, meta: { synthMs, sessionCached: lastSessionCached } }, [wav]);
    } catch (err: any) {
        (self as any).postMessage({ id, error: err?.message ?? String(err) });
    }
};
