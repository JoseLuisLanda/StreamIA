import { Injectable, signal } from '@angular/core';
import { MotionRecording, AudioEntry } from '../lib/motion/motion.models';

const DB_NAME = 'MotionStudioDB';
const DB_VERSION = 2;
const STORE_NAME = 'motionRecordings';
const AUDIO_STORE = 'motionAudio';

/**
 * Typed IndexedDB wrapper for MotionRecording persistence.
 * Uses a separate DB from LiveAppDB to avoid version collisions.
 */
@Injectable({ providedIn: 'root' })
export class MotionStoreService {
    readonly recordings = signal<MotionRecording[]>([]);

    private db: IDBDatabase | null = null;
    private initPromise: Promise<void> | null = null;

    // ---- lifecycle ----------------------------------------------------------

    async load(): Promise<void> {
        await this.ensureDb();
        const all = await this.getAll();
        // Sort newest first
        all.sort((a, b) => b.createdAt - a.createdAt);
        this.recordings.set(all);
    }

    // ---- CRUD ---------------------------------------------------------------

    async save(rec: MotionRecording): Promise<void> {
        await this.ensureDb();
        await this.put(rec);
        // Update the signal
        this.recordings.update(list => {
            const idx = list.findIndex(r => r.id === rec.id);
            if (idx >= 0) {
                const next = [...list];
                next[idx] = rec;
                return next;
            }
            return [rec, ...list];
        });
    }

    async delete(id: string): Promise<void> {
        await this.ensureDb();
        await this.remove(id);
        // Best-effort: remove audio blobs (ignore if not present)
        await this.removeAudio(id).catch(() => {});
        this.recordings.update(list => list.filter(r => r.id !== id));
    }

    // ---- export / import ----------------------------------------------------

    exportJson(rec: MotionRecording): string {
        return JSON.stringify(rec, null, 2);
    }

    importJson(json: string): MotionRecording | null {
        try {
            const obj = JSON.parse(json);
            if (!obj.id || !obj.label || !Array.isArray(obj.frames)) {
                console.warn('[motion-store] Invalid recording JSON — missing required fields');
                return null;
            }
            return obj as MotionRecording;
        } catch {
            console.warn('[motion-store] Failed to parse recording JSON');
            return null;
        }
    }

    /** Generate a TypeScript snippet for pasting into gesture-library.ts */
    toTypescriptSnippet(rec: MotionRecording): string {
        if (!rec.compiledGesture) return '// No compiled gesture available — save to library first.';
        const def = rec.compiledGesture;
        const lines: string[] = [
            `{`,
            `    id: '${def.id}',`,
            `    defaultRepetitions: ${def.defaultRepetitions},`,
            `    defaultSpeed: '${def.defaultSpeed ?? 'normal'}',`,
            `    returnDuration: ${def.returnDuration.toFixed(2)},`,
            `    entryEasing: '${def.entryEasing}',`,
            `    exitEasing: '${def.exitEasing}',`,
            def.allowMouth ? `    allowMouth: true,` : '',
            `    channels: [`,
            ...def.channels.map(ch => {
                const kf = ch.keyframes.map(k => `{ t: ${k.t.toFixed(3)}, v: ${k.v.toFixed(3)} }`).join(', ');
                return `        { type: '${ch.type}', target: '${ch.target}', keyframes: [${kf}] },`;
            }),
            `    ],`,
            `},`,
        ];
        return lines.filter(Boolean).join('\n');
    }


    // ---- audio blob store ---------------------------------------------------

    async saveAudio(entry: AudioEntry): Promise<void> {
        await this.ensureDb();
        await this.putAudio(entry);
    }

    async loadAudio(id: string): Promise<AudioEntry | null> {
        await this.ensureDb();
        return this.getAudio(id);
    }

    async deleteAudio(id: string): Promise<void> {
        await this.ensureDb();
        await this.removeAudio(id);
    }

    // ---- IndexedDB internals ------------------------------------------------

    private ensureDb(): Promise<void> {
        if (this.db) return Promise.resolve();
        if (this.initPromise) return this.initPromise;
        this.initPromise = new Promise<void>((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => { this.db = req.result; resolve(); };
            req.onupgradeneeded = (event: any) => {
                const db: IDBDatabase = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(AUDIO_STORE)) {
                    db.createObjectStore(AUDIO_STORE, { keyPath: 'id' });
                }
            };
        });
        return this.initPromise;
    }

    private getAll(): Promise<MotionRecording[]> {
        return new Promise((resolve, reject) => {
            const tx = this.db!.transaction([STORE_NAME], 'readonly');
            const req = tx.objectStore(STORE_NAME).getAll();
            req.onsuccess = () => resolve(req.result as MotionRecording[]);
            req.onerror = () => reject(req.error);
        });
    }

    private put(rec: MotionRecording): Promise<void> {
        return new Promise((resolve, reject) => {
            const tx = this.db!.transaction([STORE_NAME], 'readwrite');
            const req = tx.objectStore(STORE_NAME).put(rec);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    private remove(id: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const tx = this.db!.transaction([STORE_NAME], 'readwrite');
            const req = tx.objectStore(STORE_NAME).delete(id);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    private putAudio(entry: AudioEntry): Promise<void> {
        return new Promise((resolve, reject) => {
            const tx = this.db!.transaction([AUDIO_STORE], 'readwrite');
            const req = tx.objectStore(AUDIO_STORE).put(entry);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    private getAudio(id: string): Promise<AudioEntry | null> {
        return new Promise((resolve, reject) => {
            const tx = this.db!.transaction([AUDIO_STORE], 'readonly');
            const req = tx.objectStore(AUDIO_STORE).get(id);
            req.onsuccess = () => resolve(req.result as AudioEntry ?? null);
            req.onerror = () => reject(req.error);
        });
    }

    private removeAudio(id: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const tx = this.db!.transaction([AUDIO_STORE], 'readwrite');
            const req = tx.objectStore(AUDIO_STORE).delete(id);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }
}
