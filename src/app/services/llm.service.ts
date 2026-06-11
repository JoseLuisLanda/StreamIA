import { Injectable, signal, WritableSignal } from '@angular/core';
import { DEFAULT_SYSTEM_PROMPT } from '../lib/llm/system-prompt';

/**
 * LLM provider abstraction for the conversational avatar.
 *
 * Providers: Ollama (local, default), OpenAI, Google Gemini, Anthropic Claude,
 * DeepSeek. Switching requires zero code changes - all config lives in the UI
 * and persists in localStorage.
 *
 * SECURITY: API keys entered in the UI are kept in localStorage and sent
 * directly from the browser to the provider. That is fine for LOCAL TESTING
 * ONLY - for production, proxy requests through your own backend. Keys are
 * never hardcoded and never logged.
 */

export type LlmProviderId = 'ollama' | 'openai' | 'gemini' | 'anthropic' | 'deepseek';

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface ProviderConfig {
    /** base URL (relevant for ollama/deepseek/openai-compatible) */
    baseUrl: string;
    model: string;
    apiKey: string;
}

export interface LlmSettings {
    provider: LlmProviderId;
    providers: Record<LlmProviderId, ProviderConfig>;
    /** history window: max user+assistant turn pairs sent to the model */
    maxTurns: number;
    /** per-reply token cap sent to every provider (discourages rambling) */
    maxReplyTokens: number;
    systemPrompt: string;
}

export const LLM_PROVIDER_LABELS: Record<LlmProviderId, string> = {
    ollama: 'Ollama (local)',
    openai: 'OpenAI',
    gemini: 'Google Gemini',
    anthropic: 'Anthropic Claude',
    deepseek: 'DeepSeek',
};

const DEFAULT_SETTINGS: LlmSettings = {
    provider: 'ollama',
    providers: {
        ollama: { baseUrl: 'http://localhost:11434', model: 'llama3.2', apiKey: '' },
        openai: { baseUrl: 'https://api.openai.com', model: 'gpt-4o-mini', apiKey: '' },
        gemini: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.0-flash', apiKey: '' },
        anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-4-5', apiKey: '' },
        deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: '' },
    },
    maxTurns: 8,
    maxReplyTokens: 220,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

const LS_KEY = 'textAvatar.llmSettings';

@Injectable({ providedIn: 'root' })
export class LlmService {
    public settings: WritableSignal<LlmSettings> = signal(this.load());
    /** user/assistant turns of the current session (system prompt excluded) */
    public history: WritableSignal<ChatMessage[]> = signal([]);
    public busy: WritableSignal<boolean> = signal(false);

    // ---------------------------------------------------------------- config

    private load(): LlmSettings {
        try {
            const raw = localStorage.getItem(LS_KEY);
            if (!raw) return structuredClone(DEFAULT_SETTINGS);
            const parsed = JSON.parse(raw);
            // deep-merge over defaults so new fields appear after upgrades
            const merged: LlmSettings = structuredClone(DEFAULT_SETTINGS);
            merged.provider = parsed.provider ?? merged.provider;
            merged.maxTurns = parsed.maxTurns ?? merged.maxTurns;
            merged.maxReplyTokens = parsed.maxReplyTokens ?? merged.maxReplyTokens;
            merged.systemPrompt = parsed.systemPrompt ?? merged.systemPrompt;
            for (const id of Object.keys(merged.providers) as LlmProviderId[]) {
                Object.assign(merged.providers[id], parsed.providers?.[id] ?? {});
            }
            return merged;
        } catch {
            return structuredClone(DEFAULT_SETTINGS);
        }
    }

    save(): void {
        localStorage.setItem(LS_KEY, JSON.stringify(this.settings()));
    }

    resetSystemPrompt(): void {
        this.settings.update(s => ({ ...s, systemPrompt: DEFAULT_SYSTEM_PROMPT }));
        this.save();
    }

    clearConversation(): void {
        this.history.set([]);
    }

    // ------------------------------------------------------------------ chat

    /**
     * Sends the user message (with windowed history) to the active provider.
     * onDelta (optional) receives the accumulated text while streaming
     * (currently implemented for Ollama; other providers resolve in one shot).
     * On success the turn is appended to history.
     */
    async sendChat(userText: string, onDelta?: (accumulated: string) => void): Promise<string> {
        const s = this.settings();
        const cfg = s.providers[s.provider];
        const windowed = this.history().slice(-s.maxTurns * 2);
        const messages: ChatMessage[] = [...windowed, { role: 'user', content: userText }];

        this.busy.set(true);
        try {
            let reply: string;
            switch (s.provider) {
                case 'ollama': reply = await this.chatOllama(cfg, s.systemPrompt, messages, onDelta); break;
                case 'openai': reply = await this.chatOpenAiCompatible(cfg, s.systemPrompt, messages, 'OpenAI'); break;
                case 'deepseek': reply = await this.chatOpenAiCompatible(cfg, s.systemPrompt, messages, 'DeepSeek'); break;
                case 'anthropic': reply = await this.chatAnthropic(cfg, s.systemPrompt, messages); break;
                case 'gemini': reply = await this.chatGemini(cfg, s.systemPrompt, messages); break;
            }
            reply = (reply ?? '').trim();
            if (!reply) throw new Error('El modelo devolvió una respuesta vacía.');
            this.history.update(h => [...h, { role: 'user', content: userText }, { role: 'assistant', content: reply }]);
            return reply;
        } finally {
            this.busy.set(false);
        }
    }

    // ------------------------------------------------------------- providers

    private async chatOllama(cfg: ProviderConfig, system: string, messages: ChatMessage[], onDelta?: (acc: string) => void): Promise<string> {
        const url = `${trimSlash(cfg.baseUrl)}/api/chat`;
        let res: Response;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: cfg.model,
                    stream: !!onDelta,
                    options: { num_predict: this.settings().maxReplyTokens },
                    messages: [{ role: 'system', content: system }, ...messages],
                }),
            });
        } catch {
            throw new Error(`No se pudo conectar a Ollama en ${cfg.baseUrl}. ¿Está corriendo? Recuerda exportar OLLAMA_ORIGINS="*" (o el origen de esta app) antes de iniciar ollama.`);
        }
        if (!res.ok) throw await this.httpError(res, 'Ollama');

        if (onDelta && res.body) {
            // NDJSON streaming
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '', acc = '';
            for (; ;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const j = JSON.parse(line);
                        if (j.message?.content) { acc += j.message.content; onDelta(acc); }
                    } catch { /* partial line */ }
                }
            }
            return acc;
        }
        const data = await res.json();
        return data.message?.content ?? '';
    }

    private async chatOpenAiCompatible(cfg: ProviderConfig, system: string, messages: ChatMessage[], label: string): Promise<string> {
        this.requireKey(cfg, label);
        const res = await fetch(`${trimSlash(cfg.baseUrl)}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${cfg.apiKey}`,
            },
            body: JSON.stringify({
                model: cfg.model,
                max_tokens: this.settings().maxReplyTokens,
                messages: [{ role: 'system', content: system }, ...messages],
            }),
        }).catch(() => { throw new Error(`No se pudo conectar a ${label}.`); });
        if (!res.ok) throw await this.httpError(res, label);
        const data = await res.json();
        return data.choices?.[0]?.message?.content ?? '';
    }

    private async chatAnthropic(cfg: ProviderConfig, system: string, messages: ChatMessage[]): Promise<string> {
        this.requireKey(cfg, 'Anthropic');
        const res = await fetch(`${trimSlash(cfg.baseUrl)}/v1/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': cfg.apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true',
            },
            body: JSON.stringify({
                model: cfg.model,
                max_tokens: this.settings().maxReplyTokens,
                system,
                messages: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
            }),
        }).catch(() => { throw new Error('No se pudo conectar a Anthropic.'); });
        if (!res.ok) throw await this.httpError(res, 'Anthropic');
        const data = await res.json();
        return (data.content ?? []).map((b: any) => b.text ?? '').join('');
    }

    private async chatGemini(cfg: ProviderConfig, system: string, messages: ChatMessage[]): Promise<string> {
        this.requireKey(cfg, 'Gemini');
        const url = `${trimSlash(cfg.baseUrl)}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: system }] },
                contents: messages.map(m => ({
                    role: m.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: m.content }],
                })),
                generationConfig: { maxOutputTokens: this.settings().maxReplyTokens },
            }),
        }).catch(() => { throw new Error('No se pudo conectar a Gemini.'); });
        if (!res.ok) throw await this.httpError(res, 'Gemini');
        const data = await res.json();
        const parts = data.candidates?.[0]?.content?.parts ?? [];
        return parts.map((p: any) => p.text ?? '').join('');
    }

    // ------------------------------------------------------------------ util

    private requireKey(cfg: ProviderConfig, label: string): void {
        if (!cfg.apiKey?.trim()) throw new Error(`Falta la API key de ${label}. Configúrala en el panel de proveedor.`);
    }

    private async httpError(res: Response, label: string): Promise<Error> {
        let detail = '';
        try {
            const j = await res.json();
            detail = j.error?.message ?? j.error ?? '';
            if (typeof detail === 'object') detail = JSON.stringify(detail);
        } catch { /* no body */ }
        if (res.status === 401 || res.status === 403) return new Error(`${label}: API key inválida o sin permisos.`);
        if (res.status === 404) return new Error(`${label}: modelo no encontrado (revisa el nombre del modelo).`);
        if (res.status === 429) return new Error(`${label}: límite de uso alcanzado, intenta más tarde.`);
        return new Error(`${label}: error HTTP ${res.status}${detail ? ' - ' + String(detail).slice(0, 140) : ''}`);
    }
}

function trimSlash(u: string): string {
    return (u ?? '').replace(/\/+$/, '');
}
