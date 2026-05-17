"""STT/LLM/TTS plugin factory.

Reads an `agent_voice_configs` row (joined into the context-bootstrap
payload) and instantiates the configured trio. Plugins not selected are
imported but not instantiated — keeps memory footprint low. Adding a
provider is one entry in `_REGISTRY` plus a seed row in `voice_providers`.

Live behavior is gated on the actual livekit-agents plugin packages being
present at runtime. The skeleton uses lazy imports + a NotImplementedError
fallback so the agent boots even if optional plugins aren't installed.

PR 1.B-Lang adds session-level multilingual: `build_cascade(voice_config,
lang)` takes the user's language (from identity.lang) and:

  - STT: injects the matching BCP-47 code into the provider's language
    config (Deepgram `language=`, AssemblyAI `language=`, Google STT
    `languages=[...]`). German users get a German STT regardless of
    whether the agent_voice_configs row pre-seeded a language.

  - TTS: looks up `tts_options.voices_per_lang[lang]` first (operator
    override), falls back to a hardcoded LANG_DEFAULTS map per provider
    (en + de + 7 more shipped today; new languages drop in via either a
    LANG_DEFAULTS entry here or per-row `voices_per_lang` from Voice
    Lab). The TTS plugin's `language` kwarg is also resolved from BCP-47
    so e.g. Google Chirp speaks German with the correct prosody.

This is pure session-time resolution — no migration needed for the
shipped languages. Adding Spanish/French/Italian/etc. is a row insert.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Protocol

logger = logging.getLogger(__name__)


class _STTPlugin(Protocol):
    """Anything livekit-agents recognizes as an STT — see livekit.agents.stt.STT."""

    pass


class _LLMPlugin(Protocol):
    pass


class _TTSPlugin(Protocol):
    pass


@dataclass
class ResolvedCascade:
    stt: _STTPlugin | None
    llm: _LLMPlugin | None
    tts: _TTSPlugin | None
    notes: list[str]


# ---------------------------------------------------------------------------
# Language → BCP-47 resolution. The agent receives short language codes
# (`en`, `de`, …) from identity.lang. STT/TTS plugins want full BCP-47
# (`en-US`, `de-DE`, …). When identity.lang is already BCP-47 we pass it
# through unchanged.
# ---------------------------------------------------------------------------

# Match Vertex's NEURAL2_TTS_VOICES set (orb-live.ts:1176): the languages
# the Vitana team has actually provisioned for production. NOT a generic
# EU/European set. Adding a language is a deliberate decision that has
# to land in BOTH pipelines.
_BCP47_DEFAULTS: dict[str, str] = {
    "en": "en-US",
    "de": "de-DE",
    "es": "es-ES",
    "fr": "fr-FR",
    "ar": "ar-XA",   # Vertex uses ar-XA (multi-region Arabic), not ar-SA
    "zh": "cmn-CN",  # Vertex uses cmn-CN (Mandarin), not zh-CN
    "ru": "ru-RU",
    "sr": "sr-RS",
}


def _resolve_bcp47(lang: str | None) -> str:
    """Resolve a short language code (or already-BCP-47 string) to BCP-47.

    `en` → `en-US`, `de` → `de-DE`, `en-US` → `en-US`. Unknown codes pass
    through; we'd rather pass an unsupported code to the provider (which
    will return a clean error) than silently downgrade to en-US and ship
    English audio to a Spanish user.
    """
    if not lang:
        return "en-US"
    s = str(lang).strip()
    if not s:
        return "en-US"
    if "-" in s and len(s) > 2:
        return s  # already BCP-47
    return _BCP47_DEFAULTS.get(s.lower(), s)


# ---------------------------------------------------------------------------
# Hardcoded fallback voices per provider+language. Used when the
# agent_voice_configs row doesn't have a `voices_per_lang` map yet. Lets
# German users hear German voices today without a migration. Operators can
# override per-row by populating `tts_options.voices_per_lang`. Adding a
# new language is a one-line addition here (or a row in voice_providers
# for the seed-from-DB pattern, when that ships).
# ---------------------------------------------------------------------------

LANG_DEFAULTS: dict[str, dict[str, str]] = {
    "google_tts": {
        # Mirrors Vertex's production set (orb-live.ts:LIVE_API_VOICES +
        # NEURAL2_TTS_VOICES). DO NOT add languages here that aren't in
        # Vertex — that's a deliberate parity violation. The previous
        # mistake (it/pt/nl/sv/pl substituted for ar/zh/ru/sr) was a
        # generic-EU pick that broke the user's actual config.
        #
        # Voice routing through livekit-plugins-google:
        #   - "chirp" in name → chirp_3 model (Cloud TTS REST GA voices)
        #   - else            → gemini-2.5-flash-tts model (multilingual,
        #                       voice name without locale prefix, model
        #                       auto-detects language from input text)
        #
        # For ar/zh/ru/sr we use Gemini TTS multilingual voices because
        # Chirp3-HD coverage outside the major Western locales is thin and
        # we'd rather use a voice that's GUARANTEED to synthesize than
        # ship a name that 400s. Mirrors Vertex's LIVE_API_VOICES which
        # uses bare names ('Charon', 'Kore') for those same languages.
        "en": "en-US-Chirp3-HD-Aoede",
        # Leda = "soft, narrative" — warmer than Aoede per user feedback.
        "de": "de-DE-Chirp3-HD-Leda",
        "es": "es-ES-Chirp3-HD-Aoede",
        "fr": "fr-FR-Chirp3-HD-Aoede",
        "ar": "Charon",  # Gemini TTS — Vertex's LIVE_API_VOICES['ar']
        "zh": "Charon",  # Gemini TTS — Vertex's LIVE_API_VOICES['zh']
        "ru": "Charon",  # Gemini TTS — Vertex's LIVE_API_VOICES['ru']
        "sr": "Charon",  # Gemini TTS — Vertex's LIVE_API_VOICES['sr']
    },
    # Cartesia Sonic-3 is multilingual — same voice handle works across
    # languages, the model auto-detects from the input text. Documented at
    # https://docs.cartesia.ai/docs/sonic — keep the same voice unless an
    # operator override exists.
    "cartesia": {},
    # ElevenLabs Multilingual v2 / Turbo v2.5 also handle multiple
    # languages from a single voice. Operators wanting per-language voices
    # set tts_options.voices_per_lang.
    "elevenlabs": {},
}


def _resolve_tts_voice(
    provider: str | None,
    fallback_model: str | None,
    options: dict[str, Any],
    lang: str,
) -> tuple[str | None, bool]:
    """Pick the TTS voice for this language.

    Returns ``(voice_id, language_locked)``. ``language_locked=True`` means
    we picked a per-language voice (from voices_per_lang or LANG_DEFAULTS),
    so the caller must force the TTS language kwarg to bcp47 — otherwise
    a row-seeded `tts_options.language_code: 'en-US'` would mismatch the
    German voice and Cloud TTS rejects the synth (silent failure was the
    bug in the first German session: voice_name='de-DE-Neural2-G' +
    language_code='en-US' → 400 → no audio).

    Resolution order:
      1. tts_options.voices_per_lang[lang]   (operator override per agent) — locked
      2. tts_options.voices_per_lang[short]  (e.g. 'de' even when full lang is 'de-AT') — locked
      3. LANG_DEFAULTS[provider][lang]       (hardcoded fallback) — locked
      4. tts_options.voices_per_lang['en']   (final lang fallback) — locked to en
      5. fallback_model                      (the row's static tts_model) — NOT locked
    """
    voices_per_lang = options.get("voices_per_lang") or {}
    if not isinstance(voices_per_lang, dict):
        voices_per_lang = {}

    short = (lang.split("-", 1)[0] if "-" in lang else lang).lower()
    candidates = [lang, short]
    for key in candidates:
        v = voices_per_lang.get(key)
        if isinstance(v, str) and v:
            return v, True

    if provider:
        prov_defaults = LANG_DEFAULTS.get(provider, {}) or {}
        for key in candidates:
            v = prov_defaults.get(key)
            if isinstance(v, str) and v:
                return v, True

    en_override = voices_per_lang.get("en")
    if isinstance(en_override, str) and en_override:
        return en_override, True

    return fallback_model, False


def build_cascade(
    voice_config: dict[str, Any] | None,
    lang: str | None = None,
    *,
    voice_override: str | None = None,
) -> ResolvedCascade:
    """Instantiate the STT/LLM/TTS plugins per the agent_voice_configs row.

    voice_config shape (matches PR #3 migration):
      {
        "stt_provider": "deepgram", "stt_model": "nova-3", "stt_options": {...},
        "llm_provider": "anthropic", "llm_model": "claude-sonnet-4-6", "llm_options": {...},
        "tts_provider": "cartesia", "tts_model": "sonic-3", "tts_options": {...}
      }

    PR 1.B-Lang: `lang` is the user's language code from identity.lang
    (`en`, `de`, …). STT receives the matching BCP-47 code; TTS resolves
    a per-language voice via voices_per_lang or LANG_DEFAULTS. When `lang`
    is None or unset (anonymous boot, missing metadata) the cascade
    behaves exactly as before — backwards-compatible.
    """
    if voice_config is None:
        # VTID-02696: hardcoded Google fallback so the agent works even when
        # context-bootstrap fails (e.g. empty GATEWAY_SERVICE_TOKEN). Once the
        # service token is set this branch is rarely hit; the row from
        # agent_voice_configs takes over.
        logger.warning("build_cascade: no voice_config — falling back to hardcoded Google cascade")
        voice_config = {
            "stt_provider": "google_stt",  "stt_model": "latest_long", "stt_options": {},
            "llm_provider": "google_llm",  "llm_model": "gemini-2.5-flash", "llm_options": {},
            "tts_provider": "google_tts",  "tts_model": "en-US-Chirp3-HD-Aoede", "tts_options": {},
        }

    notes: list[str] = []
    resolved_lang = lang or "en"
    bcp47 = _resolve_bcp47(resolved_lang)
    if lang and lang != "en":
        notes.append(f"language: identity.lang={lang} → bcp47={bcp47}")

    stt = _build_stt(
        voice_config.get("stt_provider"),
        voice_config.get("stt_model"),
        voice_config.get("stt_options", {}),
        notes,
        bcp47=bcp47,
    )
    llm = _build_llm(voice_config.get("llm_provider"), voice_config.get("llm_model"), voice_config.get("llm_options", {}), notes)
    tts = _build_tts(
        voice_config.get("tts_provider"),
        voice_config.get("tts_model"),
        voice_config.get("tts_options", {}),
        notes,
        lang=resolved_lang,
        bcp47=bcp47,
        voice_override=voice_override,
    )
    return ResolvedCascade(stt=stt, llm=llm, tts=tts, notes=notes)


# VTID-03037: STT FallbackAdapter wiring. Defaults ON; kill switch is
# ORB_STT_FALLBACK_ENABLED=false. attempt_timeout intentionally sits a
# couple seconds under watchdogs.STALL_THRESHOLD_MS (10s) so the adapter
# swaps before the stall watchdog fires its (now-vestigial) soft reset.
def _fallback_enabled() -> bool:
    return os.environ.get("ORB_STT_FALLBACK_ENABLED", "true").lower() not in (
        "false", "0", "no", "off",
    )


def _fallback_attempt_timeout_s() -> float:
    raw = os.environ.get("ORB_STT_FALLBACK_ATTEMPT_TIMEOUT_MS", "8000")
    try:
        return max(1.0, float(raw) / 1000.0)
    except (TypeError, ValueError):
        return 8.0


def _build_single_stt(
    provider: str | None,
    model: str | None,
    opts: dict[str, Any],
    notes: list[str],
    *,
    bcp47: str,
) -> _STTPlugin | None:
    """Construct ONE STT instance. Caller owns opts hygiene + notes."""
    if provider == "deepgram":
        try:
            from livekit.plugins import deepgram  # type: ignore[import-not-found]
            return deepgram.STT(model=model or "nova-3", language=bcp47, **opts)
        except ImportError:
            notes.append("STT provider 'deepgram' requested but livekit-plugins-deepgram not installed")
            return None
        except Exception as exc:  # noqa: BLE001
            notes.append(f"STT provider 'deepgram' init failed: {exc}")
            return None
    if provider == "assemblyai":
        try:
            from livekit.plugins import assemblyai  # type: ignore[import-not-found]
            return assemblyai.STT(language=bcp47, **opts)
        except ImportError:
            notes.append("STT provider 'assemblyai' requested but livekit-plugins-assemblyai not installed")
            return None
        except Exception as exc:  # noqa: BLE001
            notes.append(f"STT provider 'assemblyai' init failed: {exc}")
            return None
    if provider == "google_stt":
        try:
            from livekit.plugins import google  # type: ignore[import-not-found]
            # Google Cloud Speech-to-Text via ADC. Passing project explicitly
            # so the plugin doesn't fall back to the consumer Speech endpoint
            # that requires GOOGLE_API_KEY. Always send identity.lang's BCP-47
            # — see comment above on why we ignore the row's `languages` field.
            return google.STT(
                model=model or "latest_long",
                languages=[bcp47],
                **opts,
            )
        except ImportError:
            notes.append("STT provider 'google_stt' requested but livekit-plugins-google not installed")
            return None
        except Exception as exc:  # noqa: BLE001
            notes.append(f"STT provider 'google_stt' init failed: {exc}")
            return None
    notes.append(f"unknown or unsupported STT provider: {provider}")
    return None


def _build_stt(
    provider: str | None,
    model: str | None,
    options: dict[str, Any],
    notes: list[str],
    *,
    bcp47: str = "en-US",
) -> _STTPlugin | None:
    """Construct the configured STT plugin and inject the user's language.

    `bcp47` is resolved from identity.lang in build_cascade. We always
    inject (overriding any pre-seeded value in stt_options) — operator
    overrides for STT language are uncommon and the per-session value
    matches the user's actual speech. Compare TTS where per-row
    voices_per_lang overrides are common.

    VTID-03037: when ORB_STT_FALLBACK_ENABLED (default true) the return
    value is a livekit-agents FallbackAdapter wrapping
    [primary, same-provider-mirror, (optional) deepgram-cross-provider].
    The adapter swaps internally if the primary stops producing
    transcripts within attempt_timeout (default 8s). The agent watchdog
    still fires at STALL_THRESHOLD_MS=10s as a backstop, but
    in-pipeline failover is the first line of defense — the
    session._activity.stt assignment trick from VTID-03005 writes to a
    slot the 0.12+ runtime doesn't read, so it can't recover on its
    own.
    """
    opts = dict(options or {})
    # Strip the multilingual-routing carrier so it doesn't leak into the
    # plugin kwargs (it's a TTS-only convention but we drop it defensively).
    opts.pop("voices_per_lang", None)
    # PR 1.B-Lang-4: ALWAYS override row-seeded language(s). The agent_voice_configs
    # row often carries hardcoded English (`languages: ['en-US']` for google_stt,
    # `language: 'en-US'` for deepgram/assemblyai) from the original Vertex-era
    # seed. STT language MUST match the user's actual speech, not a per-agent
    # config — there is no operator override that makes sense here. Drop the row
    # values; the bcp47 resolved from identity.lang is always correct.
    opts.pop("language", None)
    opts.pop("languages", None)

    primary = _build_single_stt(provider, model, opts, notes, bcp47=bcp47)
    if primary is None:
        return None

    if not _fallback_enabled():
        return primary

    instances: list[_STTPlugin] = [primary]

    # Same-provider mirror — fresh connection/state. Catches the most
    # common failure mode we see in production (Google STT gRPC stream
    # silently stops producing events; a new instance has its own
    # stream). Uses the same opts so language/model match the primary.
    mirror = _build_single_stt(provider, model, dict(opts), notes, bcp47=bcp47)
    if mirror is not None and mirror is not primary:
        instances.append(mirror)
        notes.append(f"stt_fallback: added same-provider mirror ({provider})")

    # Cross-provider fallback — only if we have a different vendor's
    # credentials lying around. DEEPGRAM_API_KEY is the trigger today;
    # when ASSEMBLYAI_API_KEY plumbing lands, mirror this block.
    if provider != "deepgram" and os.environ.get("DEEPGRAM_API_KEY"):
        deep = _build_single_stt("deepgram", "nova-3", {}, notes, bcp47=bcp47)
        if deep is not None:
            instances.append(deep)
            notes.append("stt_fallback: added cross-provider deepgram")

    if len(instances) < 2:
        # Couldn't build a second instance. The single primary is still
        # better than nothing — return it unwrapped so we don't pay the
        # FallbackAdapter overhead for no resilience benefit.
        notes.append("stt_fallback: only 1 instance built — returning unwrapped primary")
        return primary

    try:
        from livekit.agents.stt import FallbackAdapter  # type: ignore[import-not-found]
        attempt_timeout = _fallback_attempt_timeout_s()
        adapter = FallbackAdapter(
            instances,
            attempt_timeout=attempt_timeout,
            max_retry_per_stt=1,
            retry_interval=5.0,
        )
        notes.append(
            f"stt_fallback: wrapped {len(instances)} instances in "
            f"FallbackAdapter (attempt_timeout={attempt_timeout}s)"
        )
        return adapter
    except ImportError:
        notes.append(
            "stt_fallback: livekit.agents.stt.FallbackAdapter unavailable — "
            "falling back to primary STT only"
        )
        return primary
    except Exception as exc:  # noqa: BLE001
        notes.append(
            f"stt_fallback: FallbackAdapter construction failed ({exc}) — "
            "falling back to primary STT only"
        )
        return primary


def _build_llm(provider: str | None, model: str | None, options: dict[str, Any], notes: list[str]) -> _LLMPlugin | None:
    if provider == "anthropic":
        try:
            from livekit.plugins import anthropic  # type: ignore[import-not-found]
            return anthropic.LLM(model=model or "claude-sonnet-4-6", **options)
        except ImportError:
            notes.append("LLM provider 'anthropic' requested but livekit-plugins-anthropic not installed")
            return None
    if provider == "openai":
        try:
            from livekit.plugins import openai  # type: ignore[import-not-found]
            return openai.LLM(model=model or "gpt-4o", **options)
        except ImportError:
            notes.append("LLM provider 'openai' requested but livekit-plugins-openai not installed")
            return None
    if provider == "google_llm":
        try:
            from livekit.plugins import google  # type: ignore[import-not-found]
            # vertexai=True switches the plugin from the consumer Gemini API
            # (which requires GOOGLE_API_KEY) to Vertex AI which uses ADC.
            # The Cloud Run service account inherits the project's Vertex AI
            # access, so no extra secret needed.
            project = os.environ.get("GOOGLE_CLOUD_PROJECT", "lovable-vitana-vers1")
            location = os.environ.get("VERTEX_AI_LOCATION", "us-central1")
            # VTID-03002: defensive remap. The previous hardcoded fallback
            # AND the agent_voice_configs.orb-agent row both shipped with
            # `gemini-3.1-flash-lite-preview` — a model name that does NOT
            # exist on Vertex AI. The Gemini call returns nothing,
            # session.generate_reply produces no audio, agent goes
            # idle → thinking → listening without ever speaking. We
            # explicitly remap any known-bad Gemini 3.x preview names to
            # the current realtime default so the row doesn't need a
            # migration to recover. The fallback below covers the
            # voice_config=None branch.
            _KNOWN_BAD_GEMINI = {"gemini-3.1-flash-lite-preview"}
            _DEFAULT_GEMINI = "gemini-2.5-flash"
            effective_model = model or _DEFAULT_GEMINI
            if effective_model in _KNOWN_BAD_GEMINI:
                notes.append(
                    f"LLM provider 'google_llm': remapped non-existent model "
                    f"'{effective_model}' → '{_DEFAULT_GEMINI}'"
                )
                effective_model = _DEFAULT_GEMINI
            return google.LLM(
                model=effective_model,
                vertexai=True,
                project=project,
                location=location,
                **options,
            )
        except ImportError:
            notes.append("LLM provider 'google_llm' requested but livekit-plugins-google not installed")
            return None
        except Exception as exc:  # noqa: BLE001
            notes.append(f"LLM provider 'google_llm' init failed: {exc}")
            return None
    notes.append(f"unknown or unsupported LLM provider: {provider}")
    return None


def _build_tts(
    provider: str | None,
    model: str | None,
    options: dict[str, Any],
    notes: list[str],
    *,
    lang: str = "en",
    bcp47: str = "en-US",
    voice_override: str | None = None,
) -> _TTSPlugin | None:
    """Construct the configured TTS plugin with a per-language voice.

    `lang` is the short identity language code (`en`/`de`/...). The voice
    is resolved via _resolve_tts_voice (operator override → LANG_DEFAULTS
    → row's tts_model). For Google TTS the `language` kwarg is also
    resolved from BCP-47 so prosody matches the voice.

    `voice_override` is a per-session voice name (passed in via the
    LiveKit token metadata from the test page's voice dropdown). When set,
    skip the LANG_DEFAULTS lookup and use it directly. Treated as
    language_locked so the row-seeded language_code can't mismatch.
    """
    if voice_override:
        voice, language_locked = voice_override, True
        notes.append(f"tts: voice_override={voice_override} (per-session)")
    else:
        voice, language_locked = _resolve_tts_voice(provider, model, options or {}, lang)
        if voice and model and voice != model:
            notes.append(f"tts: resolved voice {voice} for lang={lang} (row model={model})")

    # Strip voices_per_lang from options since plugins won't accept it.
    opts_base = dict(options or {})
    opts_base.pop("voices_per_lang", None)
    if language_locked:
        # The voice we picked is bound to a specific language. Drop any
        # row-seeded language/language_code so they can't mismatch the
        # voice (e.g. en-US language_code + de-DE-Neural2-G voice → silent
        # 400 from Cloud TTS — that was the German bug).
        opts_base.pop("language", None)
        opts_base.pop("language_code", None)

    if provider == "cartesia":
        try:
            from livekit.plugins import cartesia  # type: ignore[import-not-found]
            # Cartesia Sonic-3 is multilingual; voice ID stays the same
            # across languages and the model auto-detects from the input.
            opts = dict(opts_base)
            opts.setdefault("language", lang)
            return cartesia.TTS(model=voice or "sonic-3", **opts)
        except ImportError:
            notes.append("TTS provider 'cartesia' requested but livekit-plugins-cartesia not installed")
            return None
        except Exception as exc:  # noqa: BLE001
            notes.append(f"TTS provider 'cartesia' init failed: {exc}")
            return None
    if provider == "elevenlabs":
        try:
            from livekit.plugins import elevenlabs  # type: ignore[import-not-found]
            # ElevenLabs Multilingual v2 / Turbo v2.5 detect language from
            # the text. voices_per_lang lets operators pick a different
            # vocal identity per language when needed.
            return elevenlabs.TTS(model=voice or "eleven_turbo_v2_5", **opts_base)
        except ImportError:
            notes.append("TTS provider 'elevenlabs' requested but livekit-plugins-elevenlabs not installed")
            return None
    if provider == "google_tts":
        try:
            from livekit.plugins import google  # type: ignore[import-not-found]
            voice_name = voice or "en-US-Chirp3-HD-Aoede"
            # tts_options from the agent_voice_configs row may carry legacy
            # keys like `language_code` (the seed migration uses Google's
            # API-side spelling). The livekit-plugins-google TTS class only
            # accepts `language=`, so an un-renamed `language_code` would
            # surface as an unexpected-kwarg TypeError → caught silently
            # below → cascade.tts=None → AgentSession runs but produces
            # silent audio. Normalise here.
            #
            # PR 1.B-Lang-3: when the voice was resolved via per-language
            # lookup (language_locked=True), opts_base no longer carries
            # any language/language_code (we stripped them above). Force
            # bcp47 so voice_name and language match. When the voice is
            # the row's static fallback (language_locked=False), respect
            # any pre-seeded language_code so operators can still pin a
            # specific locale per agent.
            opts = dict(opts_base)
            language = opts.pop("language", None) or opts.pop("language_code", None) or bcp47
            # Drop any other keys the Google plugin doesn't accept rather
            # than crash. Whitelist only the kwargs we know are safe; future
            # additions need to be added explicitly.
            allowed = {
                "gender", "voice_cloning_key", "model_name", "prompt",
                "sample_rate", "pitch", "effects_profile_id", "speaking_rate",
                "volume_gain_db", "location", "audio_encoding",
                "credentials_info", "credentials_file", "tokenizer",
                "custom_pronunciations", "use_streaming", "enable_ssml",
                "use_markup",
            }
            forwarded = {k: v for k, v in opts.items() if k in allowed}
            dropped = sorted(set(opts.keys()) - allowed)
            if dropped:
                notes.append(f"google_tts: dropped unsupported tts_options keys: {dropped}")
            # User-tuned speaking rate. VTID-03019: bumped 1.1 → 1.15 — at
            # 1.1 the Chirp3-HD voices still feel slow against real-time
            # voice expectations; 1.15 sits in the conversational sweet
            # spot (~50-60wpm faster than baseline) without sounding
            # rushed. Operators can override per agent via
            # tts_options.speaking_rate.
            forwarded.setdefault("speaking_rate", 1.15)
            # VTID-03019: enable streaming synthesis by default so audio
            # frames start flowing as soon as the first phoneme is
            # synthesized, instead of waiting for the full utterance to
            # be generated. Cuts time-to-first-audio on the agent's
            # responses by a few hundred ms per turn. livekit-plugins-google
            # supports use_streaming on Google Cloud TTS REST (Chirp3 path).
            forwarded.setdefault("use_streaming", True)
            # Google Cloud Text-to-Speech via ADC (no API key needed).
            return google.TTS(voice_name=voice_name, language=language, **forwarded)
        except ImportError:
            notes.append("TTS provider 'google_tts' requested but livekit-plugins-google not installed")
            return None
        except Exception as exc:  # noqa: BLE001
            notes.append(f"TTS provider 'google_tts' init failed: {exc}")
            return None
    notes.append(f"unknown or unsupported TTS provider: {provider}")
    return None
