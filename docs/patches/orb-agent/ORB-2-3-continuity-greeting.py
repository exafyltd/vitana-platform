"""
PATCH STUB — ORB Recovery 2+3 (DEV-COMHU-0503) — LiveKit agent greeting parity.

WHERE THIS GOES
    Repo:  exafyltd/vitana-platform (services/agents/orb-agent/session.py is NOT
           present in the autonomous sandbox checkout)
    File:  services/agents/orb-agent/session.py

WHY
    The gateway now (a) persists/hydrates close-reopen continuity via the
    orb_session_state table + POST/GET /api/v1/orb/session/continuity, and
    (b) writes the previously-missing wake_cadence:last_turn_at signal so the
    greeting-decay policy can compute seconds_since_last_turn_anywhere.

    For the Vertex path the greeting decision is applied gateway-side. The
    LiveKit Python agent constructs and speaks its OWN greeting, so it must
    honor the same decision rather than always playing the full intro.

ACCEPTANCE (after applying)
    - On reopen within 15 min, the agent receives policy in ('skip',
      'brief_resume') and does NOT replay the full daily-journey greeting.
    - On a genuinely new day / first session it still greets fully.
    - Logout/account-switch (continuity cleared) → next session greets fresh.

REFERENCE INTEGRATION
    The gateway should pass the resolved greeting policy to the agent in the
    room metadata / job payload (e.g. job.metadata JSON: {"greeting_policy":
    "skip"|"brief_resume"|"warm_return"|"fresh_intro"}). The agent reads it and
    gates its opening utterance accordingly.
"""

# --- in the agent's session entrypoint, after joining the room ---

GREETING_POLICY_FULL = ("warm_return", "fresh_intro")
GREETING_POLICY_SUPPRESSED = ("skip", "brief_resume")


def resolve_greeting_policy(job_metadata: dict) -> str:
    """Read the gateway-resolved greeting policy from job metadata.

    Defaults to 'fresh_intro' when absent (safe: a brand-new session greets).
    """
    policy = (job_metadata or {}).get("greeting_policy")
    if policy in GREETING_POLICY_FULL or policy in GREETING_POLICY_SUPPRESSED:
        return policy
    return "fresh_intro"


async def maybe_speak_greeting(session, job_metadata: dict, build_full_greeting, build_brief_resume):
    """Gate the opening utterance on the gateway-resolved policy.

    - skip          → say nothing; wait for the user to speak.
    - brief_resume  → a short "we're back" line, no daily-journey overview.
    - warm_return / fresh_intro → full greeting as today.
    """
    policy = resolve_greeting_policy(job_metadata)
    if policy == "skip":
        return  # do NOT play any greeting
    if policy == "brief_resume":
        await session.say(build_brief_resume())
        return
    await session.say(build_full_greeting())


# NOTE: also honor continuity hydration if the agent maintains its own
# conversation context — read GET /api/v1/orb/session/continuity (service token)
# at session start and seed the conversation_id / recent transcript so the
# LiveKit path resumes identically to Vertex.
