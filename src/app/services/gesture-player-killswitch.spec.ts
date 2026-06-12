import { describe, it, expect } from 'vitest';
import { GesturePlayerService } from './gesture-player.service';
import { GESTURE_MAP } from '../lib/gestures/gesture-library';

const isNeutral = (s: { morphs: Record<string, number>; head: { x: number; y: number; z: number } }) =>
    Object.values(s.morphs).every(v => Math.abs(v) < 1e-3) &&
    Math.abs(s.head.x) < 1e-3 && Math.abs(s.head.y) < 1e-3 && Math.abs(s.head.z) < 1e-3;

describe('waiting-gesture kill switch (cancelTransient at audio start)', () => {
    it('no channel writes after audio start beyond the return blend; nothing further scheduled', () => {
        const p = new GesturePlayerService();
        const ret = GESTURE_MAP.get('thinking')!.returnDuration;

        p.triggerTransient('thinking', 1, 'slow');
        // simulate frames while waiting: gesture is visibly active
        let active = false;
        for (let t = 0.05; t <= 1.0; t += 0.05) {
            if (!isNeutral(p.sample(t))) active = true;
        }
        expect(active).toBe(true);

        // a chained transient pick is pending for later
        p.schedule('thinking', 2.0, 1, 'fast', false, true);

        // AUDIO STARTS at t=1.0 -> single kill switch
        p.cancelTransient(1.0);

        // during the return blend (<= returnDuration) residual writes may decay
        // after exitStart + returnDuration: ZERO writes, forever
        for (let t = 1.0 + ret + 0.02; t <= 3.5; t += 0.05) {
            expect(isNeutral(p.sample(t))).toBe(true);
        }
        // and the pending transient pick was dropped (nothing further scheduled)
        expect(p.pendingOrActiveCount).toBe(0);
    });

    it('plan-scheduled (non-transient) gestures are NOT killed by the switch', () => {
        const p = new GesturePlayerService();
        p.schedule('yes', 0.5, 1, 'fast', false, false); // performance-plan gesture
        p.cancelTransient(0.4);
        let active = false;
        for (let t = 0.55; t <= 1.2; t += 0.05) {
            if (!isNeutral(p.sample(t))) active = true;
        }
        expect(active).toBe(true);
    });

    it('clear({keepTransient:true}) at speak entry preserves the waiting gesture', () => {
        const p = new GesturePlayerService();
        p.triggerTransient('thinking', 1, 'slow');
        p.sample(0.2);
        p.clear({ keepTransient: true });
        expect(isNeutral(p.sample(0.4))).toBe(false); // still thinking through synthesis
        p.cancelTransient(0.5);                        // dies at audio start
        const ret = GESTURE_MAP.get('thinking')!.returnDuration;
        expect(isNeutral(p.sample(0.5 + ret + 0.05))).toBe(true);
    });
});

describe('audio start is never gated on gesture state', () => {
    it('cancelTransient and clear are fully synchronous (no promises, immediate state)', () => {
        const p = new GesturePlayerService();
        p.triggerTransient('thinking', 1, 'slow');
        p.sample(0.2);
        const r1 = p.cancelTransient(0.25) as unknown;
        expect(r1).toBeUndefined();               // not thenable -> cannot be awaited by the player
        expect(p.activeGestureId).toBeNull();     // state applied in the same tick
        const r2 = p.clear() as unknown;
        expect(r2).toBeUndefined();
        expect(p.pendingOrActiveCount).toBe(0);
        // ordering contract (audited in playPlan): every AudioBufferSourceNode is
        // created and start()ed synchronously BEFORE the kill switch / reveal
        // bookkeeping — gesture blending always runs in parallel with audio.
    });
});
