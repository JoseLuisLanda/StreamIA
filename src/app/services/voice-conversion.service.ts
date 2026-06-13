import { Injectable, signal } from '@angular/core';
import { PiperClient } from '../lib/performance/piper-client';
import { textToVisemes, scaleTimeline, VisemeFrame } from '../lib/lipsync/text-to-visemes';
import { VoiceAttachment } from '../lib/motion/motion.models';
import { TtsLang } from './tts-lipsync.service';

export interface ConversionResult {
    ttsAudioData: ArrayBuffer;
    ttsAudioDurationSec: number;
    lipsyncFrames: VisemeFrame[];
}

/**
 * Converts a spoken transcript into a TTS audio file + lipsync data
 * using the Piper VITS engine (Phase 1 — no cloud required).
 *
 * Phase 2 (Azure) will replace/extend convertPiper() with Azure STT + Neural TTS
 * while keeping the same public interface and data model.
 */
@Injectable({ providedIn: 'root' })
export class VoiceConversionService {
    /** true while synthesis is in progress */
    readonly converting = signal(false);
    /** 0..1 download/synthesis progress */
    readonly progress = signal(0);

    private piper = new PiperClient();

    /**
     * Synthesize `transcript` using Piper `voiceId` and build a viseme timeline.
     * Returns the WAV bytes + decoded duration + aligned VisemeFrame[].
     */
    async convertPiper(
        transcript: string,
        voiceId: string,
        lang: TtsLang,
    ): Promise<ConversionResult> {
        if (!transcript.trim()) {
            throw new Error('Transcript is empty — nothing to synthesize.');
        }
        this.converting.set(true);
        this.progress.set(0);
        try {
            // 1. Synthesize WAV via existing Piper worker
            const wavData = await this.piper.synthesizeWav(
                transcript.trim(), voiceId,
                (p: number) => this.progress.set(p),
            );

            // 2. Decode to measure actual duration
            const audioCtx = new AudioContext();
            const audioBuffer = await audioCtx.decodeAudioData(wavData.slice(0));
            const ttsAudioDurationSec = audioBuffer.duration;
            await audioCtx.close();

            // 3. Rule-based viseme timeline — same path used by TtsLipsyncService.speak()
            const events = textToVisemes(transcript.trim(), lang);
            const lipsyncFrames = scaleTimeline(events, 0, ttsAudioDurationSec);

            return { ttsAudioData: wavData, ttsAudioDurationSec, lipsyncFrames };
        } finally {
            this.converting.set(false);
            this.progress.set(0);
        }
    }

    /**
     * Build a VoiceAttachment (metadata only — audio bytes stored separately
     * in MotionStoreService.audioStore) from a successful conversion result.
     */
    buildAttachment(
        result: ConversionResult,
        transcript: string,
        voiceId: string,
        rawAudioMimeType?: string,
    ): VoiceAttachment {
        return {
            transcript,
            transcriptConfirmed: true,
            ttsAudioDurationSec: result.ttsAudioDurationSec,
            lipsyncFrames: result.lipsyncFrames,
            voiceId,
            provider: 'piper',
            rawAudioMimeType,
        };
    }
}
