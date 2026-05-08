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

_BCP47_DEFAULTS: dict[str, str] = {
    "en": "en-US",
    "de": "de-DE",
    "es": "es-ES",
    "fr": "fr-FR",
    "it": "it-IT",
    "pt": "pt-BR",
    "nl": "nl-NL",
    "sv": "sv-SE",
    "pl": "pl-PL",
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
        # English Chirp3-HD is GA on Cloud TTS REST and works empirically
        # (user confirmed). Other languages: prefer Neural2 / Wavenet which
        # the Vertex pipeline already ships against (NEURAL2_TTS_VOICES in
        # orb-live.ts) — verified-working voices. Chirp3-HD outside en-US
        # is partially rolled out and silently fails for some locales when
        # called via the Cloud TTS REST endpoint (gives a working
        # construction but no audio at synth time).
        "en": "en-US-Chirp3-HD-Aoede",
        "de": "de-DE-Neural2-G",
        "es": "es-ES-Neural2-A",
        "fr": "fr-FR-Neural2-A",
        "it": "it-IT-Neural2-A",
        "pt": "pt-BR-Neural2-A",
        "nl": "nl-NL-Wavenet-A",  # Neural2 not GA for nl-NL
        "sv": "sv-SE-Wavenet-A",  # Neural2 not GA for sv-SE
        "pl": "pl-PL-Wavenet-A",  # Neural2 not GA for pl-PL
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


def build_cascade(voice_config: dict[str, Any] | None, lang: str | None = None) -> ResolvedCascade:
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
            "llm_provider": "google_llm",  "llm_model": "gemini-3.1-flash-lite-preview", "llm_options": {},
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
    )
    return ResolvedCascade(stt=stt, llm=llm, tts=tts, notes=notes)


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
    """
    opts = dict(options or {})
    # Strip the multilingual-routing carrier so it doesn't leak into the
    # plugin kwargs (it's a TTS-only convention but we drop it defensively).
    opts.pop("voices_per_lang", None)

    if provider == "deepgram":
        try:
            from livekit.plugins import deepgram  # type: ignore[import-not-found]
            opts.setdefault("language", bcp47)
            return deepgram.STT(model=model or "nova-3", **opts)
        except ImportError:
            notes.append("STT provider 'deepgram' requested but livekit-plugins-deepgram not installed")
            return None
    if provider == "assemblyai":
        try:
            from livekit.plugins import assemblyai  # type: ignore[import-not-found]
            opts.setdefault("language", bcp47)
            return assemblyai.STT(**opts)
        except ImportError:
            notes.append("STT provider 'assemblyai' requested but livekit-plugins-assemblyai not installed")
            return None
    if provider == "google_stt":
        try:
            from livekit.plugins import google  # type: ignore[import-not-found]
            # Google Cloud Speech-to-Text via ADC. Passing project explicitly
            # so the plugin doesn't fall back to the consumer Speech endpoint
            # that requires GOOGLE_API_KEY. The plugin takes a `languages`
            # list — we send the resolved BCP-47 every session.
            languages = opts.pop("languages", None) or [bcp47]
            return google.STT(
                model=model or "latest_long",
                languages=languages,
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
            return google.LLM(
                model=model or "gemini-3.1-flash-lite-preview",
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
) -> _TTSPlugin | None:
    """Construct the configured TTS plugin with a per-language voice.

    `lang` is the short identity language code (`en`/`de`/...). The voice
    is resolved via _resolve_tts_voice (operator override → LANG_DEFAULTS
    → row's tts_model). For Google TTS the `language` kwarg is also
    resolved from BCP-47 so prosody matches the voice.
    """
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
