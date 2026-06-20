/**
 * Client GESTURE SUB-FLAGS (debug) -- narrow down which gestures cause the
 * first-play stutter. Each flag gates exactly one path; the master kill-switch
 * gates all of them (master off -> everything off). Mirror of the server flags in
 * functions/src/lib/flags.ts (flip the matching pair to change behavior).
 *
 * Defaults for THIS test: body ON, lead-in / tail / thinking OFF.
 * Flip any single line below to isolate a path.
 *
 * What each flag controls (client):
 *   - GESTURES_BODY_ENABLED:     inline body gestures during speech
 *                                (tts-lipsync.service.speak() gesture list `gIn`).
 *   - GESTURES_LEADIN_ENABLED:   the lead-in gesture before TTS
 *                                (conversation.service gLead + replay() lead block).
 *   - GESTURES_TAIL_ENABLED:     the tail gesture after TTS
 *                                (conversation.service gTail + replay() tail block).
 *   - GESTURES_THINKING_ENABLED: the keep-alive "thinking" waiting micro-gesture
 *                                loop (conversation.service gThinking).
 */
const GESTURES_MASTER = false; // overall kill-switch: false -> ALL gestures off (set true to restore per-flag values below)

export const GESTURES_BODY_ENABLED = GESTURES_MASTER && true;
export const GESTURES_LEADIN_ENABLED = GESTURES_MASTER && false;
export const GESTURES_TAIL_ENABLED = GESTURES_MASTER && false;
export const GESTURES_THINKING_ENABLED = GESTURES_MASTER && false;
