/**
 * VTID-02867: Per-TTS-provider quality rollup.
 *
 * Reads the last N days of voice session-stop OASIS events, attributes
 * each session to its TTS provider via metadata, computes audio-in-zero
 * rate and one-way rate per provider, and returns a small array suitable
 * for the strip at the top of the Providers & Voice card.
 *
 * The provider attribution prefers `metadata.tts.provider` (new) and
 * falls back to inspecting `metadata.voice` against the Google TTS voice
 * name patterns. Sessions without an attributable provider land in
 * `unknown` so the operator can spot mis-tagging.
 */

import { getSupabase } from '../lib/supabase';

export interface ProviderQualityRow {
  provider: string;
  sessions_observed: number;
  audio_in_zero_count: number;
  one_way_count: number;
  audio_in_zero_ratio: number;
  one_way_ratio: number;
  median_duration_ms: number | null;
}

export interface ProviderQualityRollup {
  generated_at: string;
  window_days: number;
  rows: ProviderQualityRow[];
}

const VOICE_NAME_TO_PROVIDER: Array<{ pattern: RegExp; provider: string }> = [
  { pattern: /^en-US-Neural2|^de-DE-Neural2|^fr-FR-Neural2|^es-ES-Neural2/, provider: 'google_tts' },
  { pattern: /-Wavenet-/, provider: 'google_tts' },
  { pattern: /-Standard-/, provider: 'google_tts' },
  { pattern: /^Kore$|^Aoede$/, provider: 'google_tts' },
];

function attributeProvider(metadata: any): string {
  if (metadata?.tts?.provider && typeof metadata.tts.provider === 'string') return metadata.tts.provider;
  const voice = typeof metadata?.voice === 'string' ? metadata.voice : null;
  if (voice) {
    for (const { pattern, provider } of VOICE_NAME_TO_PROVIDER) {
      if (pattern.test(voice)) return provider;
    }
  }
  return 'unknown';
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? Math.floor((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

export async function getProviderQualityRollup(windowDays = 7): Promise<ProviderQualityRollup> {
  const sb = getSupabase();
  const generated_at = new Date().toISOString();
  if (!sb) return { generated_at, window_days: windowDays, rows: [] };

  const since = new Date(Date.now() - windowDays * 24 * 3600_000).toISOString();
  const { data, error } = await sb
    .from('oasis_events')
    .select('topic, metadata, occurred_at')
    .in('topic', ['vtid.live.session.stop', 'voice.live.session.ended'])
    .gte('occurred_at', since)
    .order('occurred_at', { ascending: false })
    .limit(2000);
  if (error || !data) return { generated_at, window_days: windowDays, rows: [] };

  type Bucket = {
    sessions: number;
    audioInZero: number;
    oneWay: number;
    durations: number[];
  };
  const buckets = new Map<string, Bucket>();

  for (const row of data as Array<{ topic: string; metadata: any; occurred_at: string }>) {
    const meta = row.metadata || {};
    const provider = attributeProvider(meta);
    const ai = Number(meta.audio_in_chunks ?? meta.audio_in ?? 0);
    const ao = Number(meta.audio_out_chunks ?? meta.audio_out ?? 0);
    const dur = Number(meta.duration_ms ?? 0);

    const b = buckets.get(provider) || { sessions: 0, audioInZero: 0, oneWay: 0, durations: [] };
    b.sessions += 1;
    if (ai === 0) b.audioInZero += 1;
    if ((ai === 0 && ao > 0) || (ao === 0 && ai > 0)) b.oneWay += 1;
    if (dur > 0) b.durations.push(dur);
    buckets.set(provider, b);
  }

  const rows: ProviderQualityRow[] = [];
  for (const [provider, b] of buckets) {
    rows.push({
      provider,
      sessions_observed: b.sessions,
      audio_in_zero_count: b.audioInZero,
      one_way_count: b.oneWay,
      audio_in_zero_ratio: b.sessions > 0 ? b.audioInZero / b.sessions : 0,
      one_way_ratio: b.sessions > 0 ? b.oneWay / b.sessions : 0,
      median_duration_ms: median(b.durations),
    });
  }
  rows.sort((a, b) => b.sessions_observed - a.sessions_observed);

  return { generated_at, window_days: windowDays, rows };
}
