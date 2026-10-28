"""LiveKit data-channel directive emission.

Vertex's voice pipeline emits structured "orb_directive" payloads via SSE/WS
so the orb widget can react out-of-band — open URLs natively, navigate to a
profile after find_community_member, autoplay a music track, etc. LiveKit
has no SSE/WS, but it does have a reliable data channel on the Room. This
module exposes a small helper that publishes a directive on a fixed topic
("orb_directive") so the test page (and eventually the production orb
widget) can subscribe and apply the same directive types byte-for-byte.

Wire-up:

    1. session.py stashes the live `Room` on the GatewayClient (`gw.room`).
    2. Tool wrappers that receive a structured directive in the gateway
       response call `await publish_orb_directive(gw.room, directive)`
       before returning the voice text to the LLM.
    3. The browser side listens to `room.on(RoomEvent.DataReceived, ...)`,
       JSON-decodes the payload, dispatches by `directive` (open_url,
       navigate, etc.) the same way the SSE/WS branch does today.

Why a fixed topic: gives subscribers a clean filter without needing to
parse every message that flows on the data channel. Reliable=True because
losing a directive (e.g. "navigate to /u/dragan1") materially breaks UX.
"""
from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

ORB_DIRECTIVE_TOPIC = "orb_directive"

# Lazy import — keeps this module importable in unit tests on machines that
# don't have livekit installed (the rest of the agent code uses the same
# pattern).
try:  # pragma: no cover
    from livekit import rtc  # type: ignore[import-not-found]
    LK_AVAILABLE = True
except ImportError:  # pragma: no cover
    rtc = None  # type: ignore[assignment]
    LK_AVAILABLE = False


async def publish_orb_directive(room: Any, payload: dict[str, Any]) -> bool:
    """Publish an orb directive on the room's data channel.

    Returns True if the publish succeeded, False otherwise. Never raises —
    a failed directive must not bubble up and kill the tool call. The LLM
    has already spoken the voice cue at this point, so a missed redirect
    becomes a user-recoverable miss (they re-ask) rather than a tool error.
    """
    if not LK_AVAILABLE or room is None:
        logger.warning("publish_orb_directive: livekit not available or room missing")
        return False

    try:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        logger.warning("publish_orb_directive: failed to JSON-encode payload: %s", exc)
        return False

    try:
        # livekit-rtc API: room.local_participant.publish_data(payload, *,
        # reliable=True, topic="...")
        await room.local_participant.publish_data(
            body,
            reliable=True,
            topic=ORB_DIRECTIVE_TOPIC,
        )
        return True
    except Exception as exc:  # noqa: BLE001 — never propagate
        logger.warning("publish_orb_directive: publish_data failed: %s", exc)
        return False


def extract_directive(body: dict[str, Any] | None) -> dict[str, Any] | None:
    """Pull a directive out of a gateway tool-response body.

    Both shapes are accepted:
      { "ok": true, "result": { "directive": {...} }, ... }
      { "ok": true, "directive": {...}, ... }

    Returns None when no directive is present (the common case for tools
    that just speak text back).
    """
    if not isinstance(body, dict):
        return None
    direct = body.get("directive")
    if isinstance(direct, dict):
        return direct
    nested = body.get("result")
    if isinstance(nested, dict):
        d = nested.get("directive")
        if isinstance(d, dict):
            return d
    return None
