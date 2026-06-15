/**
 * Client-side LLM admin model (mirror of functions/src/lib/llm-config.ts).
 *
 * Key-based providers only: OpenAI, DeepSeek, Gemini (API key). Vertex removed.
 *
 * NON-SECRET only. The API key is NEVER part of this model and is never read back
 * from Firestore -- it lives in Secret Manager (set via the setLlmApiKey
 * callable). The UI only knows whether a key is "configured" (keyStatus).
 */
export type LlmProviderId = 'openai' | 'deepseek' | 'gemini-api';

export const PROVIDERS: LlmProviderId[] = ['openai', 'deepseek', 'gemini-api'];

export interface LlmConfig {
  provider: LlmProviderId;
  model: string;
  temperature: number;
  maxOutputTokens: number;
  topP?: number;
  /** OpenAI-compatible / DeepSeek / self-hosted / Gemini base URL override. */
  baseUrl?: string;
  updatedAt?: number;
  updatedBy?: string;
}

/** Per-provider key status (non-secret) shown as "configured" in the UI. */
export interface KeyStatusEntry {
  updatedAt?: number;
  updatedBy?: string;
}
export type KeyStatus = Partial<Record<LlmProviderId, KeyStatusEntry>>;

/** Default = a sensible API-key provider (form initial values only). */
export const DEFAULT_LLM_CONFIG: LlmConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  temperature: 0.2,
  maxOutputTokens: 1024,
  topP: 0.95,
};

export const PROVIDER_LABELS: Record<LlmProviderId, string> = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  'gemini-api': 'Gemini (API key)',
};

/** Sensible model suggestions per provider (free-text field; not enforced). */
export const MODEL_SUGGESTIONS: Record<LlmProviderId, string[]> = {
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  'gemini-api': ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'],
};

export interface TestConnectionResult {
  ok: boolean;
  provider: string;
  model: string;
  sample?: string;
  error?: string;
}
