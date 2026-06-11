import { describe, it, expect } from 'vitest';
import { GesturePlayerService } from './gesture-player.service';
import { MOUTH_KEYS } from '../lib/lipsync/viseme-map';

// Sampling is driven with explicit wall-clock timestamps anchored just after construction
// (so the first frame has a ~0 delta, matching the real render loop) and is fully deterministic.

function make(): { svc: GesturePlayerService; base: number } {
    const svc = new GesturePlayerService();
    return { svc, base: performance.now() / 1000 };
}

describe('GesturePlayerService', () => {
    it('never drives mouth/jaw morphs while a (non-mouth) gesture plays', () => {
        const { svc, base } = make();
        svc.schedule('surprise', base);
        svc.sample(base);            // baseline frame: promote, phase 0
        const s = svc.sample(base + 0.3); // advance into the gesture

        // surprise drives brows/eyes only — lipsync owns the mouth, so none of these appear
        for (const key of MOUTH_KEYS) {
            expect(s.morphs[key] ?? 0).toBe(0);
        }
        // ...but a brow morph is clearly active
        expect(s.morphs['browInnerUp']).toBeGreaterThan(0);
    });

    it('cancels the current gesture when a new one starts (single slot)', () => {
        const { svc, base } = make();
        svc.schedule('yes', base);
        svc.sample(base);
        expect(svc.activeGestureId).toBe('yes');
        expect(svc.isExiting).toBe(false);

        svc.schedule('no', base + 0.1);
        svc.sample(base + 0.1);

        // the new gesture is now the only active one; the previous is blending out
        expect(svc.activeGestureId).toBe('no');
        expect(svc.isExiting).toBe(true);
    });

    it('plays exactly one full cycle for [no]:[1] then settles to neutral', () => {
        const { svc, base } = make();
        svc.schedule('no', base, 1); // 1 repetition; "no" speed = normal -> 1 cycle/sec
        svc.sample(base);
        svc.sample(base + 0.5);
        expect(svc.activeGestureId).toBe('no'); // mid-cycle, still playing

        svc.sample(base + 1.01); // phase passes 1 -> completed
        expect(svc.activeGestureId).toBeNull();
        expect(svc.isExiting).toBe(true);

        svc.sample(base + 1.01 + 0.31); // exit blend (returnDuration 0.3) finished
        expect(svc.isExiting).toBe(false);
        expect(svc.pendingOrActiveCount).toBe(0);
    });

    it('plays exactly two full cycles for [no]:[2]', () => {
        const { svc, base } = make();
        svc.schedule('no', base, 2); // 2 repetitions -> ~2 seconds at normal speed
        svc.sample(base);
        svc.sample(base + 1.5);
        expect(svc.activeGestureId).toBe('no'); // first cycle done, second in progress

        svc.sample(base + 2.01); // phase passes 2 -> completed
        expect(svc.activeGestureId).toBeNull();
    });

    it('produces additive head rotation for a head gesture', () => {
        const { svc, base } = make();
        svc.schedule('no', base); // head.y shake
        svc.sample(base);
        const s = svc.sample(base + 0.2);
        expect(Math.abs(s.head.y)).toBeGreaterThan(0);
    });
});
