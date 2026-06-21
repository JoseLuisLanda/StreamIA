/**
 * Main-thread client for the Piper synthesis worker.
 *
 * Diagnostics: logs worker construction, the path each synth takes (WORKER vs
 * MAIN), and a HARD error if main-thread synthesis ever runs (it blocks the UI).
 *
 * ALLOW_MAIN_THREAD_FALLBACK: when false, a failed worker throws instead of
 * synthesizing on the main thread -> the UI can NEVER freeze (cost: no audio
 * until the worker is fixed, with a loud error). Keep true to preserve audio
 * while diagnosing; flip to false to prove the freeze is gone.
 */
const ALLOW_MAIN_THREAD_FALLBACK = true;

export interface SynthMeta {
    synthMs: number;
    sessionCached: boolean;
}

export class PiperClient {
    /** metadata of the most recent completed synthesis (worker path) */
    public lastSynthMeta: SynthMeta | null = null;

    private worker: Worker | null = null;
    private workerFailed = false;
    private lastWorkerError = '';
    private nextId = 1;
    private pending = new Map<number, {
        resolve: (wav: ArrayBuffer) => void;
        reject: (e: Error) => void;
        onProgress?: (p: number) => void;
    }>();
    private mainModule: any = null;

    async synthesizeWav(text: string, voiceId: string, onProgress?: (p: number) => void): Promise<ArrayBuffer> {
        if (!this.workerFailed) {
            try {
                return await this.viaWorker(text, voiceId, onProgress);
            } catch (e: any) {
                this.lastWorkerError = e?.message ?? String(e);
                console.error('[piper] WORKER path FAILED -> ' + this.lastWorkerError);
                this.workerFailed = true; // latched: do not keep retrying a broken worker
                this.disposeWorker();
            }
        }
        if (!ALLOW_MAIN_THREAD_FALLBACK) {
            const msg = '[piper] main-thread fallback DISABLED; worker unavailable: ' + (this.lastWorkerError || 'unknown');
            console.error(msg);
            throw new Error(msg);
        }
        return this.viaMainThread(text, voiceId, onProgress);
    }

    dispose(): void {
        this.disposeWorker();
    }

    // ------------------------------------------------------------- worker path

    private ensureWorker(): Worker {
        if (this.worker) return this.worker;
        let w: Worker;
        try {
            w = new Worker(new URL('../../workers/piper.worker', import.meta.url), { type: 'module' });
            console.info('[piper] worker constructed OK (module worker)');
        } catch (e: any) {
            console.error('[piper] worker CONSTRUCTION failed: ' + (e?.message ?? e));
            throw e;
        }
        w.onmessageerror = (e) => console.error('[piper] worker messageerror', e);
        w.onmessage = (e: MessageEvent) => {
            const { id, wav, error, progress, meta } = e.data ?? {};
            const req = this.pending.get(id);
            if (!req) return;
            if (progress !== undefined) { req.onProgress?.(progress); return; }
            this.pending.delete(id);
            if (meta) this.lastSynthMeta = meta as SynthMeta;
            if (error) req.reject(new Error(error));
            else req.resolve(wav as ArrayBuffer);
        };
        w.onerror = (e) => {
            const err = new Error('Piper worker error: ' + (e.message ?? 'unknown'));
            for (const [, req] of this.pending) req.reject(err);
            this.pending.clear();
        };
        this.worker = w;
        return w;
    }

    private viaWorker(text: string, voiceId: string, onProgress?: (p: number) => void): Promise<ArrayBuffer> {
        const w = this.ensureWorker();
        const id = this.nextId++;
        console.info('[piper] synth -> WORKER (id=' + id + ', chars=' + (text?.length ?? 0) + ')');
        return new Promise<ArrayBuffer>((resolve, reject) => {
            this.pending.set(id, { resolve, reject, onProgress });
            w.postMessage({ id, text, voiceId });
        });
    }

    private disposeWorker(): void {
        if (this.worker) { try { this.worker.terminate(); } catch { /* gone */ } this.worker = null; }
        this.pending.clear();
    }

    // -------------------------------------------------------- main-thread path

    private async viaMainThread(text: string, voiceId: string, onProgress?: (p: number) => void): Promise<ArrayBuffer> {
        console.error(
            '[piper] *** SYNTHESIS RUNNING ON THE MAIN THREAD (viaMainThread) -- this BLOCKS the UI ***'
            + ' chars=' + (text?.length ?? 0)
            + ' | worker error: ' + (this.lastWorkerError || 'n/a'),
        );
        this.mainModule = this.mainModule ?? (await import('@diffusionstudio/vits-web'));
        const blob: Blob = await this.mainModule.predict({ text, voiceId }, (p: any) => {
            if (p?.total) onProgress?.(Math.min(1, p.loaded / p.total));
        });
        return blob.arrayBuffer();
    }
}
