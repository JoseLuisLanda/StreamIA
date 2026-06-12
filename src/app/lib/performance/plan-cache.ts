import { PerformancePlan } from './performance-compiler';

/**
 * LRU cache of compiled performances keyed by chat message id, so the replay
 * button re-performs instantly (decoded buffers included, zero re-synthesis).
 * Older entries are evicted; replay then recompiles transparently.
 */
export class PlanCache {
    private map = new Map<number, PerformancePlan[]>();

    constructor(public readonly maxEntries = 10) { }

    get(id: number): PerformancePlan[] | undefined {
        const v = this.map.get(id);
        if (v !== undefined) {
            // refresh LRU position
            this.map.delete(id);
            this.map.set(id, v);
        }
        return v;
    }

    set(id: number, plans: PerformancePlan[]): void {
        if (this.map.has(id)) this.map.delete(id);
        this.map.set(id, plans);
        while (this.map.size > this.maxEntries) {
            const oldest = this.map.keys().next().value as number;
            this.map.delete(oldest);
        }
    }

    has(id: number): boolean { return this.map.has(id); }
    clear(): void { this.map.clear(); }
    get size(): number { return this.map.size; }
}
