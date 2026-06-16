/**
 * Client-side LLM PROFILE models (mirror of functions/src/lib/llm-profiles.ts).
 * NON-SECRET only. Key VALUES live in Secret Manager; the UI sees only LlmKeyRef
 * metadata (label/secretName/active) and writes values write-only via callables.
 */
import { LlmProviderId } from './llm-admin.models';

export interface LlmKeyRef {
  id: string;
  label: string;
  secretName: string;
  active: boolean;
  updatedAt?: number;
}

export interface LlmConfigProfile {
  id: string;
  name: string;
  scope: 'global' | 'assistant';
  ownerAssistantId?: string;
  provider: LlmProviderId;
  model: string;
  temperature: number;
  maxOutputTokens: number;
  topP?: number;
  baseUrl?: string;
  keys: LlmKeyRef[];
  isSystemDefault?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface TestProfileResult {
  ok: boolean;
  provider?: string;
  model?: string;
  key?: string;
  sample?: string;
  error?: string;
}

/** A fresh draft profile (form initial values). */
export function newProfileDraft(scope: 'global' | 'assistant', ownerAssistantId?: string): LlmConfigProfile {
  return {
    id: '',
    name: '',
    scope,
    ownerAssistantId,
    provider: 'openai',
    model: 'gpt-4o-mini',
    temperature: 0.2,
    maxOutputTokens: 1024,
    topP: 0.95,
    keys: [],
  };
}

export function activeKeyOf(p: LlmConfigProfile | null | undefined): LlmKeyRef | null {
  if (!p) return null;
  return p.keys.find((k) => k.active) ?? p.keys[0] ?? null;
}
