"""
PATCH STUB — ORB Recovery 4 (DEV-COMHU-0504) — audio-ready gate (LiveKit agent).

WHERE THIS GOES
    Repo:  exafyltd/vitana-platform (services/agents/orb-agent/session.py NOT in
           the autonomous sandbox checkout)
    File:  services/agents/orb-agent/session.py

WHY
    Don't waste the one important greeting before the client can play it. The
    gateway now records an audio-ready ack in orb_session_state
    ('audio_ready_ack', keyed by user, value.session_id). The Vertex path gates
    the greeting on ack-or-3s-timeout (see the gateway follow-up patch). The
    LiveKit agent must apply the SAME gate before publishing its greeting track.

ACCEPTANCE (after applying)
    - If the client audio unlock is delayed, the agent waits for the ack (up to
      3s) before publishing the greeting.
    - If 3s elapse with no ack, the agent greets anyway (never strand the user).
    - On reconnect where first_audio_ended was recorded within 15 min, do NOT
      republish a full greeting.
"""

import asyncio

AUDIO_READY_TIMEOUT_S = 3.0
AUDIO_READY_POLL_MS = 150


async def wait_for_audio_ready(read_ack, session_id: str) -> bool:
    """Poll orb_session_state for the audio_ready_ack for this session.

    `read_ack()` is an async callable returning the ack dict or None (the agent
    wires it to a service-role GET of orb_session_state key 'audio_ready_ack').
    Returns True if the ack arrived within the timeout, False on timeout.
    """
    deadline = asyncio.get_event_loop().time() + AUDIO_READY_TIMEOUT_S
    while asyncio.get_event_loop().time() < deadline:
        ack = await read_ack()
        if ack and ack.get("session_id") == session_id:
            return True
        await asyncio.sleep(AUDIO_READY_POLL_MS / 1000.0)
    return False


# INTEGRATION SKETCH — before publishing the greeting:
#
#   ready = await wait_for_audio_ready(read_ack, session_id)
#   if not ready:
#       logger.info("audio-ready gate timed out (3s) — greeting anyway")
#   await maybe_speak_greeting(session, job_metadata, ...)  # from ORB-2-3 patch
