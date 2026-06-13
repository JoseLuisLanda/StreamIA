import { Injectable, signal, inject } from '@angular/core';
import { GestureDef, GESTURE_LIBRARY, GESTURE_MAP } from '../lib/gestures/gesture-library';
import { MotionStoreService } from './motion-store.service';

/**
 * Manages dynamically registered gestures (recorded via Gesture Studio).
 *
 * On construction it:
 *  1. Loads all saved MotionRecordings from IndexedDB via MotionStoreService.
 *  2. Registers each compiledGesture into the live GESTURE_MAP, making them
 *     immediately available to GesturePlayerService.trigger() — no code changes needed.
 *
 * Registration/unregistration is also exposed for live add/remove from the UI.
 */
@Injectable({ providedIn: 'root' })
export class CustomGestureRegistryService {
    private store = inject(MotionStoreService);

    /** All custom (recorded) gestures currently registered */
    readonly customGestures = signal<GestureDef[]>([]);

    /** All gestures: built-in GESTURE_LIBRARY + custom registered */
    readonly allGestures = () => [...GESTURE_LIBRARY, ...this.customGestures()];

    constructor() {
        // Boot-time: load persisted recordings and register their compiled gestures
        void this.bootstrapFromStorage();
    }

    // ---- public API ---------------------------------------------------------

    /** Register a GestureDef into the live GESTURE_MAP (and the custom list signal). */
    register(def: GestureDef): void {
        GESTURE_MAP.set(def.id, def);
        this.customGestures.update(list => {
            const filtered = list.filter(g => g.id !== def.id);
            return [...filtered, def];
        });
        console.log(`[gesture-registry] registered '${def.id}'`);
    }

    /** Remove a custom gesture from the live GESTURE_MAP and the signal. */
    unregister(id: string): void {
        // Never remove built-in gestures
        if (GESTURE_LIBRARY.some(g => g.id === id)) {
            console.warn(`[gesture-registry] '${id}' is a built-in gesture — cannot unregister`);
            return;
        }
        GESTURE_MAP.delete(id);
        this.customGestures.update(list => list.filter(g => g.id !== id));
        console.log(`[gesture-registry] unregistered '${id}'`);
    }

    /** Check if a gesture id is registered (built-in or custom) */
    has(id: string): boolean {
        return GESTURE_MAP.has(id);
    }

    /** True if this id belongs to the built-in library */
    isBuiltIn(id: string): boolean {
        return GESTURE_LIBRARY.some(g => g.id === id);
    }

    // ---- boot ---------------------------------------------------------------

    private async bootstrapFromStorage(): Promise<void> {
        try {
            await this.store.load();
            const registered: GestureDef[] = [];
            for (const rec of this.store.recordings()) {
                if (rec.compiledGesture) {
                    GESTURE_MAP.set(rec.compiledGesture.id, rec.compiledGesture);
                    registered.push(rec.compiledGesture);
                }
            }
            if (registered.length > 0) {
                this.customGestures.set(registered);
                console.log(`[gesture-registry] auto-registered ${registered.length} custom gesture(s) from storage`);
            }
        } catch (e) {
            console.warn('[gesture-registry] boot load failed:', e);
        }
    }
}
