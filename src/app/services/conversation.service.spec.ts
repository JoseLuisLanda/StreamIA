import { describe, it, expect } from 'vitest';
import { CONV_TRANSITIONS, canTransition, interruptTarget, ConvState } from '../lib/conversation/conv-states';

const STATES: ConvState[] = ['idle', 'listening', 'sending', 'waiting_llm', 'speaking', 'error'];

describe('conversation state machine', () => {
    it('allows the happy path idle→listening→sending→waiting_llm→speaking→idle', () => {
        expect(canTransition('idle', 'listening')).toBe(true);
        expect(canTransition('listening', 'sending')).toBe(true);
        expect(canTransition('sending', 'waiting_llm')).toBe(true);
        expect(canTransition('waiting_llm', 'speaking')).toBe(true);
        expect(canTransition('speaking', 'idle')).toBe(true);
    });

    it('supports continuous mode: speaking→listening', () => {
        expect(canTransition('speaking', 'listening')).toBe(true);
    });

    it('interrupt() from EVERY state lands on idle and is always legal', () => {
        for (const s of STATES) {
            const target = interruptTarget(s);
            expect(target).toBe('idle');
            expect(canTransition(s, target)).toBe(true);
        }
    });

    it('error is reachable from the active pipeline stages', () => {
        expect(canTransition('sending', 'error')).toBe(true);
        expect(canTransition('waiting_llm', 'error')).toBe(true);
        expect(canTransition('speaking', 'error')).toBe(true);
        expect(canTransition('listening', 'error')).toBe(true);
    });

    it('error recovers: error→idle, error→speaking (fallback line), error→listening', () => {
        expect(canTransition('error', 'idle')).toBe(true);
        expect(canTransition('error', 'speaking')).toBe(true);
        expect(canTransition('error', 'listening')).toBe(true);
    });

    it('forbids skipping the pipeline (idle→waiting_llm, listening→speaking)', () => {
        expect(canTransition('idle', 'waiting_llm')).toBe(false);
        expect(canTransition('listening', 'speaking')).toBe(false);
        expect(canTransition('listening', 'waiting_llm')).toBe(false);
    });

    it('manual text mode: idle→speaking is legal', () => {
        expect(canTransition('idle', 'speaking')).toBe(true);
    });

    it('self transitions are no-ops, always legal', () => {
        for (const s of STATES) expect(canTransition(s, s)).toBe(true);
    });

    it('every state has at least one exit defined', () => {
        for (const s of STATES) expect(CONV_TRANSITIONS[s].length).toBeGreaterThan(0);
    });
});
