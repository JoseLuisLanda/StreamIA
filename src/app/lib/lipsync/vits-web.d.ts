/** Minimal typings for @diffusionstudio/vits-web (engine loaded lazily at runtime). */
declare module '@diffusionstudio/vits-web' {
    export interface TtsProgress { url: string; loaded: number; total: number; }
    export function predict(
        config: { text: string; voiceId: string },
        callback?: (progress: TtsProgress) => void
    ): Promise<Blob>;
    export function download(voiceId: string, callback?: (progress: TtsProgress) => void): Promise<void>;
    export function voices(): Promise<unknown>;
    export function stored(): Promise<string[]>;
    export function flush(): Promise<void>;
    export function remove(voiceId: string): Promise<void>;
}
