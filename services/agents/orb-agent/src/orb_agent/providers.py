"""STT/LLM/TTS plugin factory.

Reads an `agent_voice_configs` row (joined into the context-bootstrap
payload) and instantiates the configured trio. Plugins not selected are
imported but not instantiated — keeps memory footprint low. Adding a
provider is one entry in `_REGISTRY` plus a seed row in `voice_providers`.

Live behavior is gated on the actual livekit-agents plugin packages being
present at runtime. The skeleton uses lazy imports + a NotImplementedError
fallback so the agent boots even if optional plugins aren't installed.
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


def build_cascade(voice_config: dict[str, Any] | None) -> ResolvedCascade:
    """Instantiate the STT/LLM/TTS plugins per the agent_voice_configs row.

    voice_config shape (matches PR #3 migration):
      {
        "stt_provider": "deepgram", "stt_model": "nova-3", "stt_options": {...},
        "llm_provider": "anthropic", "llm_model": "claude-sonnet-4-6", "llm_options": {...},
        "tts_provider": "cartesia", "tts_model": "sonic-3", "tts_options": {...}
      }
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
    stt = _build_stt(voice_config.get("stt_provider"), voice_config.get("stt_model"), voice_config.get("stt_options", {}), notes)
    llm = _build_llm(voice_config.get("llm_provider"), voice_config.get("llm_model"), voice_config.get("llm_options", {}), notes)
    tts = _build_tts(voice_config.get("tts_provider"), voice_config.get("tts_model"), voice_config.get("tts_options", {}), notes)
    return ResolvedCascade(stt=stt, llm=llm, tts=tts, notes=notes)


def _build_stt(provider: str | None, model: str | None, options: dict[str, Any], notes: list[str]) -> _STTPlugin | None:
    if provider == "deepgram":
        try:
            from livekit.plugins import deepgram  # type: ignore[import-not-found]
            return deepgram.STT(model=model or "nova-3", **options)
        except ImportError:
            notes.append(f"STT provider 'deepgram' requested but livekit-plugins-deepgram not installed")
            return None
    if provider == "assemblyai":
        try:
            from livekit.plugins import assemblyai  # type: ignore[import-not-found]
            return assemblyai.STT(**options)
        except ImportError:
            notes.append(f"STT provider 'assemblyai' requested but livekit-plugins-assemblyai not installed")
            return None
    if provider == "google_stt":
        try:
            from livekit.plugins import google  # type: ignore[import-not-found]
            # Google Cloud Speech-to-Text via ADC. Passing project explicitly
            # so the plugin doesn't fall back to the consumer Speech endpoint
            # that requires GOOGLE_API_KEY.
            return google.STT(
                model=model or "latest_long",
                languages=options.pop("languages", ["en-US"]),
                **options,
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


def _build_tts(provider: str | None, model: str | None, options: dict[str, Any], notes: list[str]) -> _TTSPlugin | None:
    if provider == "cartesia":
        try:
            from livekit.plugins import cartesia  # type: ignore[import-not-found]
            return cartesia.TTS(model=model or "sonic-3", **options)
        except ImportError:
            notes.append("TTS provider 'cartesia' requested but livekit-plugins-cartesia not installed")
            return None
    if provider == "elevenlabs":
        try:
            from livekit.plugins import elevenlabs  # type: ignore[import-not-found]
            return elevenlabs.TTS(model=model or "eleven_turbo_v2_5", **options)
        except ImportError:
            notes.append("TTS provider 'elevenlabs' requested but livekit-plugins-elevenlabs not installed")
            return None
    if provider == "google_tts":
        try:
            from livekit.plugins import google  # type: ignore[import-not-found]
            voice = model or "en-US-Chirp3-HD-Aoede"
            # tts_options from the agent_voice_configs row may carry legacy
            # keys like `language_code` (the seed migration uses Google's
            # API-side spelling). The livekit-plugins-google TTS class only
            # accepts `language=`, so an un-renamed `language_code` would
            # surface as an unexpected-kwarg TypeError → caught silently
            # below → cascade.tts=None → AgentSession runs but produces
            # silent audio. Normalise here.
            opts = dict(options or {})
            language = opts.pop("language", None) or opts.pop("language_code", None) or "en-US"
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
            return google.TTS(voice_name=voice, language=language, **forwarded)
        except ImportError:
            notes.append("TTS provider 'google_tts' requested but livekit-plugins-google not installed")
            return None
        except Exception as exc:  # noqa: BLE001
            notes.append(f"TTS provider 'google_tts' init failed: {exc}")
            return None
    notes.append(f"unknown or unsupported TTS provider: {provider}")
    return None
