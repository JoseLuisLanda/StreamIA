/**
 * Pure conversation state machine definition (no Angular imports - unit testable).
 *
 *   idle -> listening -> sending -> waiting_llm -> speaking -> idle
 *                 \________________ interrupt() ________________/
 *   error is entered from active stages and recovers to idle
 *   (optionally via 'speaking' for the spoken fallback line).
 */

export type ConvState = 'idle' | 'listening' | 'sending' | 'waiting_llm' | 'speaking' | 'error';

export const CONV_TRANSITIONS: Record<ConvState, ConvState[]> = {
    idle: ['listening', 'speaking', 'sending'],
    listening: ['sending', 'idle', 'error'],
    sending: ['waiting_llm', 'error', 'idle'],
    waiting_llm: ['speaking', 'error', 'idle'],
    // 'waiting_llm' is legal from 'speaking': the info-ack FILLER is spoken
    // (speaking) and then the turn returns to waiting for the RAG/LLM answer.
    speaking: ['idle', 'listening', 'error', 'waiting_llm'],
    error: ['idle', 'listening', 'speaking'],
};

export function canTransition(from: ConvState, to: ConvState): boolean {
    if (from === to) return true;
    return CONV_TRANSITIONS[from]?.includes(to) ?? false;
}

/** interrupt() is legal from EVERY state and always lands on idle. */
export function interruptTarget(_from: ConvState): ConvState {
    return 'idle';
}
