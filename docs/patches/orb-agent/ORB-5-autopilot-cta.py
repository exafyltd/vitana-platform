"""
PATCH STUB — ORB Recovery 5 (DEV-COMHU-0505) — autopilot CTA (LiveKit agent).

WHERE THIS GOES
    Repo:  exafyltd/vitana-platform (services/agents/orb-agent/session.py NOT in
           the autonomous sandbox checkout)
    File:  services/agents/orb-agent/session.py (+ the agent's tools.py)

WHY
    The continuation CTA now carries `onYesTool: 'activate_recommendation'` +
    `payload.id` (gateway-side, autopilot-recommendation.ts). The shared
    activator `tool_activate_recommendation` (orb-tools-shared.ts) already
    distinguishes activated / already-active / not-found / wrong-user. The
    LiveKit agent must declare the SAME tool with an identical signature and,
    when a pending CTA exists, prefer it so "yes" is deterministic.

ACCEPTANCE (after applying)
    - Every spoken permission offer carries an executable pending CTA.
    - "Yes" after an autopilot offer calls activate_recommendation(id=<rec id>).
    - Unauthorized user → truthful fallback (not "I have no access").
    - Identical behavior to the Vertex path.
"""

# --- in the agent's tools.py: declare the tool with the shared signature ---

from livekit.agents import llm


@llm.ai_callable(
    description="Activate the autopilot recommendation the user just agreed to. "
    "Call this when the user says yes to a recommendation offer."
)
async def activate_recommendation(self, id: str) -> str:
    """id: autopilot_recommendations.id (from the pending CTA payload)."""
    # Delegate to the gateway's shared activator via the REST route so Vertex
    # and LiveKit share one implementation:
    #   POST /api/v1/autopilot/recommendations/activate { id }
    result = await self._gateway_post("/api/v1/autopilot/recommendations/activate", {"id": id})
    if result.get("ok"):
        r = result.get("result", {})
        title = r.get("title") or "that recommendation"
        if r.get("already_active"):
            return f'"{title}" was already on your active list.'
        return f'Done — "{title}" is on your active list.'
    err = result.get("error", "")
    if err == "recommendation_belongs_to_another_user":
        return "That recommendation isn't on your account, so I can't activate it."
    if err == "recommendation_not_found":
        return "I couldn't find that recommendation anymore — it may have expired."
    return "I couldn't activate that just now. You can open Autopilot to do it manually."


# --- pending-CTA preference: read orb_session_state 'pending_cta' at turn start ---
#
# When the gateway writes a pending CTA into orb_session_state (key 'pending_cta',
# value { tool: 'activate_recommendation', payload: { id } }, 5-min TTL), the agent
# should, on an affirmative user turn ("yes"/"ja"/"sure"), invoke the pending tool
# with its payload rather than re-deriving intent. Read via a service-role GET of
# orb_session_state (mirrors the ORB-2-3 / ORB-4 hydration pattern).
