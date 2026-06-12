import { describe, it, expect } from 'vitest';
import { PlanCache } from './plan-cache';
import { PerformancePlan } from './performance-compiler';

const fakePlan = (d: number): PerformancePlan[] => ([{
    events: [{ type: 'silence', t0: 0, t1: d, srcIndex: 0 }],
    gestures: [], visemeTrack: [], buffers: new Map(), duration: d, compileMs: 1,
}] as PerformancePlan[]);

describe('PlanCache', () => {
    it('returns the IDENTICAL plan object (no recompilation) on replay', () => {
        const c = new PlanCache(10);
        const plans = fakePlan(2);
        c.set(7, plans);
        expect(c.get(7)).toBe(plans); // same reference -> same event timeline, zero synthesis
    });

    it('evicts least-recently-used beyond maxEntries', () => {
        const c = new PlanCache(3);
        c.set(1, fakePlan(1)); c.set(2, fakePlan(2)); c.set(3, fakePlan(3));
        c.get(1);              // refresh 1
        c.set(4, fakePlan(4)); // evicts 2
        expect(c.has(1)).toBe(true);
        expect(c.has(2)).toBe(false);
        expect(c.has(3)).toBe(true);
        expect(c.has(4)).toBe(true);
    });

    it('clear() empties the cache', () => {
        const c = new PlanCache(5);
        c.set(1, fakePlan(1));
        c.clear();
        expect(c.size).toBe(0);
    });
});
