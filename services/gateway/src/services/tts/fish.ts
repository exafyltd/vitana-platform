/**
 * Fish Audio TTS — language-coverage fallback for Polly (VTID-03970).
 *
 * Polly cannot speak Serbian at all (`POLLY_UNSUPPORTED_LANGS`, see
 * `polly.ts`), and with GCP decommissioned there is no Google TTS left to
 * fall back to either — CLAUDE.md §2c has called this "currently
 * silent/broken in production" since VTID-03495. Fish Audio is a
 * multilingual zero-shot TTS provider that DOES cover Serbian (and many
 * other languages Polly/Nova Sonic don't), so this module exists to fill
 * exactly that gap — never to replace Polly for languages it already
 * serves well.
 *
 * ## This is a FALLBACK, not a primary provider
 *
 * `TTS_PROVIDER` (see `tts-provider.ts`) still only selects `google` or
 * `polly`. Fish is not a third value for that switch — it is invoked from
 * inside `tryPollySynthesis()`'s failure branch, ONLY when the language is
 * one Polly has no voice for at all (not on a transient Polly API error —
 * a real outage should surface as an outage, not be silently papered over
 * by routing every failure through an unverified third-party). This keeps
 * the existing "one seam, every call site benefits" architecture the
 * header of `tts-provider.ts` documents, instead of adding a second
 * seam every caller has to know about.
 *
 * ## Explicit opt-in, explicit key — same shape as every other provider here
 *
 * Gated on BOTH `TTS_FISH_FALLBACK_ENABLED=true` AND `FISH_API_KEY` being
 * set (mirrors `BEDROCK_ROLE_ARN`'s "unconfigured → not_configured → the
 * router skips it" contract, CLAUDE.md IF-THEN 31). Deploying this file
 * changes nothing until both are set explicitly.
 *
 * ## Voice selection — curated, not user-supplied
 *
 * Fish Audio hosts community-uploaded voice clones with no content
 * moderation on their sample text. A Serbian voice suggested for this
 * integration (`f8c26ecae994449faf73bcfae844076b`, "Srpski Razgovorni
 * Glas") turned out to carry an explicit sexual description and
 * `sexy`/`intimate`/`breathy` tags — completely unusable for a health/
 * wellness assistant. `FISH_VOICES` below is therefore a short, manually
 * reviewed table (like `POLLY_VOICES`), not a lookup into Fish's public
 * catalog at request time. Adding a language means picking (and reading
 * the full description of) a specific `reference_id`, the same discipline
 * `polly.ts`'s per-language table already applies.
 *
 * `sr` → `2ad62aaf885e4a14add09fe4a38ffd23` ("Milica - Female Serbian"),
 * published by Fish Audio's own official account (`author.nickname ===
 * 'Fish Official'`), described as "A natural, professional Serbian voice
 * ... suited to voice assistants, customer support and everyday
 * narration" — verified via `GET /model/{id}` 2026-09-16, not assumed
 * from the search listing. One metadata quirk worth knowing about, not a
 * blocker: the model's own `languages` field reports `["hr"]` (Croatian),
 * not `sr`, despite the title/tags/description all being explicitly
 * Serbian (`sr-rs` is itself one of the tags) — Fish's language
 * classification appears coarser than its own marketing copy here. A real
 * synthesis call with Serbian text (below) produced correct-sounding
 * output regardless, so this is flagged as a documentation curiosity, not
 * treated as disqualifying.
 *
 * ## Live-verified (VTID-03983)
 *
 * VTID-03970's build could not get a real `POST /v1/tts` response — every
 * attempt against the default paid `s2.1-pro` model returned HTTP 402
 * ("Insufficient API credit") with the supplied key. VTID-03983 found why:
 * Fish's S2.1 Pro has a free tier, `s2.1-pro-free` (no character cap, no
 * SLA/latency guarantee, requests may be retained for model improvement —
 * acceptable for a rarely-hit language-gap fallback). The SAME unfunded
 * key synthesized real audio against it on the first try — HTTP 200, a
 * valid 29,256-byte MP3 (confirmed via `file`: MPEG layer III, 128kbps,
 * 44.1kHz), for `sr` text "Zdravo, ovo je test." A parallel `pcm` request
 * for the same text produced a byte count whose duration at the requested
 * 16kHz (1.81s) closely matches the mp3's own duration (1.83s) — Fish
 * honors the requested PCM sample rate, confirming the assumption
 * documented on `FISH_PCM_SAMPLE_RATE_HZ` below. `getFishModel()` now
 * defaults to `s2.1-pro-free`; `scripts/tts/verify-fish-voice.ts` runs the
 * same checks in a repeatable script.
 */

export interface FishVoiceConfig {
  /** Fish Audio `reference_id` — selects voice timbre/style. */
  referenceId: string;
  /** Human-readable label for logs, matching Polly's `voice` field shape. */
  label: string;
}

/**
 * Language → Fish Audio voice. Deliberately small and manually curated —
 * see the module header on why this is not a live catalog lookup.
 */
const FISH_VOICES: Record<string, FishVoiceConfig> = {
  sr: { referenceId: '2ad62aaf885e4a14add09fe4a38ffd23', label: 'Milica (Fish Official)' },
};

/**
 * VTID-04445 — Devon's (the specialist's) Fish voice per language: the male
 * voice of the same Fish Official series as Milica, for the languages where
 * Polly has no male voice at all (`tr`, `zh` — Polly's documented and live
 * `DescribeVoices` list) or no voice at all (`sr`). Owner rule: every Devon
 * voice is a man's voice, so these are the ONLY way Devon can speak in those
 * languages on the cascade — never Vitana's female voice.
 *
 * Each read via `GET /model/{id}` 2026-09-23: author `Fish Official`, tags
 * `male, young, conversational, professional, clear`, description "A natural,
 * professional <language> voice … suited to voice assistants, customer
 * support and everyday narration", `dmca_taken_down: false`. `zh` is the
 * Mainland Mandarin voice, matching Polly's cmn-CN receptionist voice.
 */
const FISH_SPECIALIST_VOICES: Record<string, FishVoiceConfig> = {
  sr: { referenceId: '076ad255234448a5b2adb3f8bd292acd', label: 'Nikola (Fish Official)' },
  tr: { referenceId: '778d117554c9470bb7c664a781fe13a5', label: 'Kerem (Fish Official)' },
  zh: { referenceId: '5d29a99739c14d4ca3e4fe42193105b2', label: 'Zixuan (Fish Official)' },
};

/** VTID-04445 — whose voice a Fish request speaks with. Omitted = Vitana. */
export type FishVoiceRole = 'receptionist' | 'specialist';

export function resolveFishVoice(lang: string, role: FishVoiceRole = 'receptionist'): FishVoiceConfig | null {
  const normalized = (lang || '').toLowerCase().split(/[-_]/)[0].slice(0, 2);
  const table = role === 'specialist' ? FISH_SPECIALIST_VOICES : FISH_VOICES;
  return table[normalized] ?? null;
}

/** Test/verification seam: both tables, read-only. */
export function listFishVoices(): {
  receptionist: Readonly<Record<string, FishVoiceConfig>>;
  specialist: Readonly<Record<string, FishVoiceConfig>>;
} {
  return { receptionist: FISH_VOICES, specialist: FISH_SPECIALIST_VOICES };
}

/**
 * Fish's free tier for its S2.1 Pro model (VTID-03983): `s2.1-pro-free`.
 * Same underlying model as the paid `s2.1-pro`, no character cap, but no
 * SLA/latency guarantee and requests may be retained for model improvement
 * (docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits)
 * — acceptable for this fallback's actual use (a rarely-hit language gap,
 * not high-volume production traffic). Defaulting to the paid `s2.1-pro`
 * was the reason every synthesis attempt during VTID-03970's build
 * returned HTTP 402 with an unfunded key — confirmed live: switching to
 * `s2.1-pro-free` with the SAME key produced a real 200 and real audio on
 * the first try. Overridable per CLAUDE.md's "always specify model_name
 * explicitly" rule (IF-THEN 30) — never left to Fish's own header default.
 */
function getFishModel(): string {
  return (process.env.FISH_TTS_MODEL || 's2.1-pro-free').trim();
}

/**
 * Fish's `pcm` output format's sample rate is requested via `sample_rate`
 * in the request body, not confirmed back in the response headers/body.
 * CONFIRMED LIVE (VTID-03983): a real PCM request for the same text used
 * for the mp3 verification produced a byte count whose duration at 16kHz
 * 16-bit mono (1.81s) matches the mp3's own duration (1.83s at 128kbps)
 * almost exactly — Fish honors the requested rate. Kept at 16kHz to match
 * the rate every other PCM-format caller in this codebase already expects
 * from a non-Google provider (`POLLY_PCM_SAMPLE_RATE_HZ`).
 */
export const FISH_PCM_SAMPLE_RATE_HZ = 16_000;

const FISH_REQUEST_TIMEOUT_MS = 15_000;

export function isFishFallbackEnabled(): boolean {
  return (process.env.TTS_FISH_FALLBACK_ENABLED || '').trim().toLowerCase() === 'true';
}

/**
 * The flag ALONE is not enough to actually serve a request — `FISH_API_KEY`
 * must be set too. Callers deciding ELIGIBILITY (e.g. the cascade gate)
 * must use this, not `isFishFallbackEnabled()` alone, or they will report a
 * language as servable that `synthesizeFish()` immediately refuses at
 * runtime for the missing key — the same "flag on, adapter unconfigured,
 * still silently serves the fallback" bug CLAUDE.md's Bedrock IF-THEN 31
 * exists to prevent, here for Fish instead of Bedrock.
 */
export function isFishConfigured(): boolean {
  return isFishFallbackEnabled() && !!process.env.FISH_API_KEY;
}

export interface FishSynthesisResult {
  audioB64: string;
  sampleRateHz: number;
  voice: string;
  languageCode: string;
}

/**
 * Synthesize `text` via Fish Audio. Returns null whenever Fish cannot (or
 * should not, per config) serve the request — never throws — so callers
 * keep the same "null means fall back / degrade" contract every other
 * provider in this directory uses.
 */
export async function synthesizeFish(opts: {
  text: string;
  lang: string;
  format: 'mp3' | 'pcm';
  /** VTID-04445 — omitted (every pre-existing caller) = Vitana's voice. */
  voiceRole?: FishVoiceRole;
}): Promise<FishSynthesisResult | null> {
  const { text, lang, format } = opts;
  if (!text || text.trim().length === 0) return null;

  if (!isFishFallbackEnabled()) {
    return null; // Deploying this file changes nothing until explicitly opted in.
  }

  const apiKey = process.env.FISH_API_KEY;
  if (!apiKey) {
    console.warn('[FISH] TTS_FISH_FALLBACK_ENABLED=true but FISH_API_KEY is unset — skipping.');
    return null;
  }

  const voice = resolveFishVoice(lang, opts.voiceRole ?? 'receptionist');
  if (!voice) {
    // Not every unsupported-by-Polly language has a curated Fish voice yet —
    // that is an explicit, growable gap (see FISH_VOICES), not a bug.
    console.warn(`[FISH] No curated Fish voice for lang='${lang}' — caller must fall back.`);
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FISH_REQUEST_TIMEOUT_MS);

  try {
    const body: Record<string, unknown> = {
      text,
      reference_id: voice.referenceId,
      format,
      normalize: true,
      // VTID-03998: `'normal'` (the previous value) is Fish's own documented
      // best-QUALITY, slowest setting (docs.fish.audio — "normal: best
      // quality (default)" vs "low: lowest latency" / "balanced: reduced
      // latency"). Live production evidence (oasis_events, pre-login sr
      // sessions on preview-aws.vitanaland.com): every anonymous Serbian
      // cascade session hit the 30s greeting_timeout stall watchdog and
      // terminated with zero audio BEFORE cascade_tts_failed even logged —
      // consistent with this request itself running close to (or past) its
      // own FISH_REQUEST_TIMEOUT_MS below. This is the ONLY voice path
      // Serbian has (Polly has no `sr` voice at all), so a slow Fish call is
      // a total outage for that language, not degraded quality. `'low'`
      // trades some audio quality for the latency this real-time voice path
      // needs — an acceptable trade for a rarely-hit language-gap fallback
      // that was otherwise producing no audio at all.
      latency: 'low',
    };
    if (format === 'pcm') {
      body.sample_rate = FISH_PCM_SAMPLE_RATE_HZ;
    }

    const res = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        model: getFishModel(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Fish returns a JSON error body even on failure (402 credit, 401 auth,
      // 503 overloaded) — log it verbatim rather than just the status code,
      // it names the actual cause (CLAUDE.md: "never silence errors").
      const errBody = await res.text().catch(() => '');
      console.warn(`[FISH] Synthesis failed (lang=${lang}, status=${res.status}): ${errBody}`);
      return null;
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes || bytes.length === 0) return null;

    return {
      audioB64: Buffer.from(bytes).toString('base64'),
      sampleRateHz: format === 'pcm' ? FISH_PCM_SAMPLE_RATE_HZ : 44_100,
      voice: voice.label,
      languageCode: lang,
    };
  } catch (err) {
    console.warn(`[FISH] Synthesis request failed (lang=${lang}, format=${format}):`, (err as Error).message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
