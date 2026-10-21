"""Video frame forwarder for vision-capable LLMs.

Mirrors orb-live.ts:12793 (`vtid.live.video.in.frame` emission). When the
configured LLM provider supports vision (Gemini, GPT-4o), forward LiveKit
video tracks at 1 FPS as JPEG 768x768 to the LLM. When the provider doesn't,
drop frames gracefully and emit a one-time warning.

Skeleton today: API surface only.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


VISION_CAPABLE_LLM_PROVIDERS = frozenset({
    "google_llm",       # gemini-2.5-flash, gemini-2.5-pro
    "openai",           # gpt-4o, gpt-4o-mini, gpt-4.1
})

VIDEO_TARGET_FPS = 1
VIDEO_TARGET_RESOLUTION = (768, 768)
VIDEO_TARGET_FORMAT = "JPEG"


def llm_supports_vision(provider: str) -> bool:
    return provider in VISION_CAPABLE_LLM_PROVIDERS


class VideoFrameForwarder:
    """Wraps a LiveKit video track and ships frames into the LLM context.

    TODO(VTID-LIVEKIT-FOUNDATION): wire to a real LiveKit video track in the
    follow-up implementation PR.
    """

    def __init__(self, llm_provider: str) -> None:
        self._enabled = llm_supports_vision(llm_provider)
        self._frames_dropped = 0
        if not self._enabled:
            logger.info(
                "VideoFrameForwarder disabled — LLM provider '%s' does not support vision. "
                "Frames will be dropped silently.",
                llm_provider,
            )

    @property
    def enabled(self) -> bool:
        return self._enabled
