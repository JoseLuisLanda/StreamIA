import { describe, it, expect } from 'vitest';
import { compilePerformance, expandSegments, planToJson, CompilerDeps } from './performance-compiler';
import { buildSpeechTimeline, PAUSE_MAP } from '../lipsync/speech-timeline';
import { parseGestureMarkup } from '../gestures/gesture-markup';

const IDS = new Set(['yes', 'no', 'surprise', 'thinking', 'sigh', 'laugh']);

/** fake AudioBuffer: ~0.05 s per char of speech; clips fixed at 1.2 s */
function fakeBuffer(duration: number): AudioBuffer {
    return { duration } as unknown as AudioBuffer;
}

function deps(): CompilerDeps {
    return {
        synthesize: async (text: string) => fakeBuffer(Math.max(0.4, text.length * 0.05)),
        getClip: async () => fakeBuffer(1.2),
        // pretend 0.1 s lead-in silence, 0.1 s tail
        measureBounds: (b) => ({ start: 0.1, end: b.duration - 0.1 }),
    };
}

async function compile(text: string) {
    const parsed = parseGestureMarkup(text, IDS);
    const plan = buildSpeechTimeline(parsed.cleanText, parsed.gestures);
    return compilePerformance(expandSegments(plan.segments), plan.gestures, 'es', deps());
}

describe('compilePerformance', () => {
    it('orders events contiguously on one time axis', async () => {
        const p = await compile('Hola amigo... esto es [sigh] una prueba completa');
        expect(p.events.length).toBeGreaterThanOrEqual(4); // speech, silence, speech?, clip, speech
        for (let i = 1; i < p.events.length; i++) {
            expect(p.events[i].t0).toBeCloseTo(p.events[i - 1].t1, 5);
        }
        expect(p.duration).toBeCloseTo(p.events[p.events.length - 1].t1, 5);
    });

    it('pause events carry the configured duration (from PAUSE_MAP)', async () => {
        const p = await compile('Hola... mundo');
        const silence = p.events.find(e => e.type === 'silence')!;
        expect(silence.t1 - silence.t0).toBeCloseTo(PAUSE_MAP['...'] / 1000, 5);
    });

    it('clip events resolve buffer + fitted gesture', async () => {
        const p = await compile('Bueno [sigh] sigamos');
        const clip = p.events.find(e => e.type === 'clip') as any;
        expect(clip).toBeTruthy();
        expect(clip.gestureId).toBe('sigh');
        expect(clip.t1 - clip.t0).toBeCloseTo(1.2, 5);
        const g = p.gestures.find(g => g.gestureId === 'sigh')!;
        expect(g.t).toBeCloseTo(clip.t0, 5);
        expect(g.allowMouth).toBe(true);
    });

    it('anchors speech gestures against the MEASURED window, not raw duration', async () => {
        const p = await compile('Hola claro que [yes]:[1] sí amigo mío');
        const speech = p.events.find(e => e.type === 'speech') as any;
        const g = p.gestures.find(g => g.gestureId === 'yes')!;
        // measured window = [t0+0.1, t1-0.1]
        expect(g.t).toBeGreaterThanOrEqual(speech.t0 + 0.1 - 1e-6);
        expect(g.t).toBeLessThanOrEqual(speech.t1 - 0.1 + 1e-6);
    });

    it('viseme track covers silence and clips with sil', async () => {
        const p = await compile('Hola... [sigh] mundo');
        const silFrames = p.visemeTrack.filter(f => f.viseme === 'sil');
        expect(silFrames.length).toBeGreaterThanOrEqual(2); // pause + clip
    });

    it('plan is serializable via planToJson', async () => {
        const p = await compile('Hola [yes]:[1] sí... mundo');
        const json = planToJson(p) as any;
        expect(() => JSON.stringify(json)).not.toThrow();
        expect(json.events.length).toBe(p.events.length);
        expect(json.duration).toBeGreaterThan(0);
    });
});

describe('revealAtTime (karaoke sampler)', () => {
    it('reveals everything exactly at audio end, monotonic, holds through pauses', async () => {
        const { revealAtTime } = await import('./performance-compiler');
        const parsed = parseGestureMarkup('Hola amigo... esto es una prueba', IDS);
        const tl = buildSpeechTimeline(parsed.cleanText, parsed.gestures);
        const plan = await compilePerformance(expandSegments(tl.segments), tl.gestures, 'es', deps());
        expect(revealAtTime(plan.events, plan.duration)).toBe(
            Math.max(...plan.events.filter(e => e.type === 'speech').map((e: any) => e.srcEnd)));
        let prev = -1;
        for (let t = 0; t <= plan.duration; t += 0.05) {
            const r = revealAtTime(plan.events, t);
            expect(r).toBeGreaterThanOrEqual(prev);
            prev = r;
        }
        expect(revealAtTime(plan.events, 0)).toBeLessThanOrEqual(1);
    });
});
