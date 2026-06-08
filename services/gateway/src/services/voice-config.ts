/**
 * VTID-02857: Voice configuration helper.
 *
 * Single source of truth for runtime-tunable voice settings:
 *   - V2V realtime provider (vertex / livekit) — already owned by orb-livekit.ts;
 *     we read it through but never write it from this module.
 *   - TTS provider, model, voice, language, speaking rate
 *   - STT provider, model (read-through; LiveKit path consumes it)
 *
 * Backed by individual `system_config` rows so each knob can be flipped
 * independently without bulk migrations:
 *   tts.provider, tts.model, tts.voice, tts.language, tts.speaking_rate
 *   stt.provider, stt.model
 *
 * In-process cache (~30s TTL) so the helper can be called inline in every
 * TTS request without thrashing Supabase.
 *
 * The dispatcher entry (`callTts`) currently implements only Google Cloud
 * TTS — the `tts.provider` setting is read and validated, but a non-Google
 * value falls back to Google with a console warning. Implementing
 * ElevenLabs / Rime / Inworld / etc. happens in follow-up PRs as needed;
 * the PUT endpoint refuses saving an unimplemented provider so config can
 * never get ahead of code.
 */

import { getSupabase } from '../lib/supabase';

export type V2VProvider = 'vertex' | 'livekit';

export interface VoiceConfig {
  active_provider: V2VProvider;
  tts: {
    provider: string; // e.g. 'google_tts'
    model: string;    // e.g. 'neural2' | 'gemini-2.5-flash-tts'
    voice: string | null;     // operator override; null = use language-default map
    language: string | null;  // operator override; null = use Accept-Language inference
    speaking_rate: number;    // 0.5 .. 2.0
  };
  stt: {
    provider: string;
    model: string;
  };
}

const DEFAULT_CONFIG: VoiceConfig = {
  active_provider: 'vertex',
  tts: {
    provider: 'google_tts',
    model: 'neural2',
    voice: null,
    language: null,
    speaking_rate: 1.0,
  },
  stt: {
    provider: 'google_stt',
    model: 'default',
  },
};

const CACHE_TTL_MS = 30_000;

let _cached: VoiceConfig | null = null;
let _cachedAt = 0;

const KEYS = {
  v2v: 'voice.active_provider',
  ttsProvider: 'tts.provider',
  ttsModel: 'tts.model',
  ttsVoice: 'tts.voice',
  ttsLanguage: 'tts.language',
  ttsSpeakingRate: 'tts.speaking_rate',
  sttProvider: 'stt.provider',
  sttModel: 'stt.model',
};

const ALL_KEYS = Object.values(KEYS);

// Providers the dispatcher actually knows how to call. Used by the PUT
// endpoint to refuse provider values that have no client implementation,
// so a stored config can never silently no-op or fall back.
export const IMPLEMENTED_TTS_PROVIDERS = new Set<string>(['google_tts']);
export const IMPLEMENTED_STT_PROVIDERS = new Set<string>(['google_stt']); // Gemini-internal counts as google

function clampSpeakingRate(n: unknown): number {
  const v = typeof n === 'number' ? n : parseFloat(String(n));
  if (!Number.isFinite(v)) return DEFAULT_CONFIG.tts.speaking_rate;
  if (v < 0.25) return 0.25;
  if (v > 4.0) return 4.0;
  return v;
}

function unwrap(raw: unknown): unknown {
  // system_config.value is JSONB. Existing rows store either a plain string
  // ("vertex") or an object ({"provider":"vertex"}). Normalize.
  if (raw && typeof raw === 'object' && 'provider' in (raw as Record<string, unknown>)) {
    return (raw as Record<string, unknown>).provider;
  }
  return raw;
}

async function readRows(): Promise<Record<string, unknown>> {
  const sb = getSupabase();
  if (!sb) return {};
  const { data, error } = await sb
    .from('system_config')
    .select('key, value')
    .in('key', ALL_KEYS);
  if (error || !data) return {};
  const out: Record<string, unknown> = {};
  for (const row of data as Array<{ key: string; value: unknown }>) {
    out[row.key] = unwrap(row.value);
  }
  return out;
}

function buildConfig(rows: Record<string, unknown>): VoiceConfig {
  const v2vRaw = rows[KEYS.v2v];
  const v2v: V2VProvider = v2vRaw === 'livekit' ? 'livekit' : 'vertex';

  const cfg: VoiceConfig = {
    active_provider: v2v,
    tts: {
      provider: typeof rows[KEYS.ttsProvider] === 'string' ? (rows[KEYS.ttsProvider] as string) : DEFAULT_CONFIG.tts.provider,
      model: typeof rows[KEYS.ttsModel] === 'string' ? (rows[KEYS.ttsModel] as string) : DEFAULT_CONFIG.tts.model,
      voice: typeof rows[KEYS.ttsVoice] === 'string' && (rows[KEYS.ttsVoice] as string).length > 0 ? (rows[KEYS.ttsVoice] as string) : null,
      language: typeof rows[KEYS.ttsLanguage] === 'string' && (rows[KEYS.ttsLanguage] as string).length > 0 ? (rows[KEYS.ttsLanguage] as string) : null,
      speaking_rate: clampSpeakingRate(rows[KEYS.ttsSpeakingRate]),
    },
    stt: {
      provider: typeof rows[KEYS.sttProvider] === 'string' ? (rows[KEYS.sttProvider] as string) : DEFAULT_CONFIG.stt.provider,
      model: typeof rows[KEYS.sttModel] === 'string' ? (rows[KEYS.sttModel] as string) : DEFAULT_CONFIG.stt.model,
    },
  };
  return cfg;
}

export async function getVoiceConfig(force = false): Promise<VoiceConfig> {
  const now = Date.now();
  if (!force && _cached && now - _cachedAt < CACHE_TTL_MS) return _cached;
  const rows = await readRows();
  _cached = buildConfig(rows);
  _cachedAt = now;
  return _cached;
}

export function invalidateVoiceConfigCache(): void {
  _cached = null;
  _cachedAt = 0;
}

export interface PutVoiceConfigInput {
  tts?: Partial<VoiceConfig['tts']>;
  stt?: Partial<VoiceConfig['stt']>;
}

export interface PutVoiceConfigResult {
  ok: boolean;
  error?: string;
  diff?: Record<string, { from: unknown; to: unknown }>;
}

export async function putVoiceConfig(
  input: PutVoiceConfigInput,
  changedBy: string | null,
): Promise<PutVoiceConfigResult> {
  const sb = getSupabase();
  if (!sb) return { ok: false, error: 'supabase client unavailable' };

  if (input.tts?.provider && !IMPLEMENTED_TTS_PROVIDERS.has(input.tts.provider)) {
    return {
      ok: false,
      error: `TTS provider '${input.tts.provider}' has no dispatcher implementation yet — refusing to save (config would silently no-op).`,
    };
  }
  if (input.stt?.provider && !IMPLEMENTED_STT_PROVIDERS.has(input.stt.provider)) {
    return {
      ok: false,
      error: `STT provider '${input.stt.provider}' has no dispatcher implementation yet — refusing to save.`,
    };
  }

  const current = await getVoiceConfig(true);
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  const upserts: Array<{ key: string; value: unknown }> = [];

  if (input.tts) {
    if (input.tts.provider !== undefined && input.tts.provider !== current.tts.provider) {
      diff[KEYS.ttsProvider] = { from: current.tts.provider, to: input.tts.provider };
      upserts.push({ key: KEYS.ttsProvider, value: input.tts.provider });
    }
    if (input.tts.model !== undefined && input.tts.model !== current.tts.model) {
      diff[KEYS.ttsModel] = { from: current.tts.model, to: input.tts.model };
      upserts.push({ key: KEYS.ttsModel, value: input.tts.model });
    }
    if (input.tts.voice !== undefined && (input.tts.voice || null) !== current.tts.voice) {
      diff[KEYS.ttsVoice] = { from: current.tts.voice, to: input.tts.voice || null };
      upserts.push({ key: KEYS.ttsVoice, value: input.tts.voice || '' });
    }
    if (input.tts.language !== undefined && (input.tts.language || null) !== current.tts.language) {
      diff[KEYS.ttsLanguage] = { from: current.tts.language, to: input.tts.language || null };
      upserts.push({ key: KEYS.ttsLanguage, value: input.tts.language || '' });
    }
    if (input.tts.speaking_rate !== undefined) {
      const next = clampSpeakingRate(input.tts.speaking_rate);
      if (next !== current.tts.speaking_rate) {
        diff[KEYS.ttsSpeakingRate] = { from: current.tts.speaking_rate, to: next };
        upserts.push({ key: KEYS.ttsSpeakingRate, value: next });
      }
    }
  }
  if (input.stt) {
    if (input.stt.provider !== undefined && input.stt.provider !== current.stt.provider) {
      diff[KEYS.sttProvider] = { from: current.stt.provider, to: input.stt.provider };
      upserts.push({ key: KEYS.sttProvider, value: input.stt.provider });
    }
    if (input.stt.model !== undefined && input.stt.model !== current.stt.model) {
      diff[KEYS.sttModel] = { from: current.stt.model, to: input.stt.model };
      upserts.push({ key: KEYS.sttModel, value: input.stt.model });
    }
  }

  if (upserts.length === 0) {
    return { ok: true, diff: {} };
  }

  for (const u of upserts) {
    const { error } = await sb.from('system_config').upsert(
      { key: u.key, value: u.value as unknown as object, updated_by: changedBy ?? 'voice-config' },
      { onConflict: 'key' },
    );
    if (error) return { ok: false, error: error.message };
  }

  invalidateVoiceConfigCache();
  return { ok: true, diff };
}
