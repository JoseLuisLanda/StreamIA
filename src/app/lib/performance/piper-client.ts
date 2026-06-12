/**
 * Main-thread client for the Piper synthesis worker.
 * Falls back to in-thread synthesis if Worker/module loading fails
 * (logged; the UI still works, just with the old blocking behavior).
 */
export interface SynthMeta {
    synthMs: number;
    sessionCached: boolean;
}

export class PiperClient {
    /** metadata of the most recent completed synthesis (worker path) */
    public lastSynthMeta: SynthMeta | null = null;

    private worker: Worker | null = null;
    private workerFailed = false;
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
                console.warn('[piper] worker synthesis failed, falling back to main thread:', e?.message ?? e);
                this.workerFailed = true;
                this.disposeWorker();
            }
        }
        return this.viaMainThread(text, voiceId, onProgress);
    }

    dispose(): void {
        this.disposeWorker();
    }

    // ------------------------------------------------------------- worker path

    private ensureWorker(): Worker {
        if (this.worker) return this.worker;
        const w = new Worker(new URL('../../workers/piper.worker', import.meta.url), { type: 'module' });
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
        this.mainModule = this.mainModule ?? (await import('@diffusionstudio/vits-web'));
        const blob: Blob = await this.mainModule.predict({ text, voiceId }, (p: any) => {
            if (p?.total) onProgress?.(Math.min(1, p.loaded / p.total));
        });
        return blob.arrayBuffer();
    }
}
