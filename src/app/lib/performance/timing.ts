/**
 * Per-reply speech-start timing instrumentation (performance.now() based).
 * One structured summary per reply: every stage delta + total + largest stage.
 */

export interface TimingMark {
    name: string;
    /** performance.now() ms */
    t: number;
}

export interface StageDelta {
    name: string;
    ms: number;
}

export interface SpeechStartSummary {
    /** ms from the reference start (llm_response_received) to audio_actually_started */
    totalMs: number;
    stages: StageDelta[];
    largest: StageDelta;
    /** whether the Piper ONNX session was reused (cache hit) for the first synth */
    sessionCached?: boolean;
}

export class TimingRecorder {
    private marks: TimingMark[] = [];

    constructor(public readonly startAt: number = performance.now()) {
        this.marks.push({ name: 'start', t: startAt });
    }

    mark(name: string): void {
        this.marks.push({ name, t: performance.now() });
    }

    has(name: string): boolean {
        return this.marks.some(m => m.name === name);
    }

    summary(sessionCached?: boolean): SpeechStartSummary {
        return buildTimingSummary(this.marks, sessionCached);
    }
}

/** Pure: consecutive deltas between marks; total = last - first. */
export function buildTimingSummary(marks: TimingMark[], sessionCached?: boolean): SpeechStartSummary {
    const stages: StageDelta[] = [];
    for (let i = 1; i < marks.length; i++) {
        stages.push({ name: marks[i].name, ms: Math.max(0, marks[i].t - marks[i - 1].t) });
    }
    const totalMs = marks.length > 1 ? Math.max(0, marks[marks.length - 1].t - marks[0].t) : 0;
    const largest = stages.reduce((a, b) => (b.ms > a.ms ? b : a), stages[0] ?? { name: 'none', ms: 0 });
    return { totalMs, stages, largest, sessionCached };
}

/** Human line for the chat process feed, e.g. "Habla iniciada en 2.1 s (síntesis: 1.6 s)". */
export function speechStartLine(s: SpeechStartSummary): string {
    const total = (s.totalMs / 1000).toFixed(1);
    const big = s.largest;
    const stage = STAGE_LABELS[big.name] ?? big.name;
    const cached = s.sessionCached === undefined ? '' : (s.sessionCached ? ', sesión reutilizada' : ', sesión nueva');
    return `Habla iniciada en ${total} s (${stage}: ${(big.ms / 1000).toFixed(1)} s${cached})`;
}

const STAGE_LABELS: Record<string, string> = {
    sanitize_done: 'sanitizado',
    parse_split_done: 'parseo',
    synthA_started: 'cola del worker',
    synthA_done: 'síntesis',
    decodeA_done: 'decodificación',
    audio_scheduled: 'compilación restante',
    audio_started: 'arranque de audio',
};
