"""JWT identity resolution + the mobile=community-role coercion (defense-in-depth).

Per memory/feedback_mobile_community_only.md: phone / WebView sessions MUST
resolve to community role regardless of the DB role, on every role-reading
path. The gateway enforces this in token mint, but we re-check here as a
second line of defense — the agent worker never trusts a "developer" role
on a mobile session.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import jwt as pyjwt

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Identity:
    user_id: str
    tenant_id: str
    role: str
    lang: str
    vitana_id: str | None
    is_mobile: bool
    is_anonymous: bool


def resolve_identity_from_room_metadata(
    metadata: dict[str, Any],
    *,
    user_jwt: str | None = None,
) -> Identity:
    """Resolve identity from LiveKit user-participant metadata + optional decoded JWT.

    The metadata dict is parsed from the user's *participant* metadata (set
    via the LiveKit AccessToken's `metadata` field by the gateway's
    /api/v1/orb/livekit/token endpoint). The function name still says
    "room_metadata" for backwards-compat with callers — the schema is
    identical (user_id/tenant_id/role/lang/vitana_id/is_mobile/is_anonymous).
    The gateway already coerces role for mobile/WebView clients; we re-check
    the mobile coercion here as defense-in-depth.
    """
    user_id = str(metadata.get("user_id", "anon"))
    tenant_id = str(metadata.get("tenant_id", ""))
    db_role = str(metadata.get("role", "community"))
    lang = str(metadata.get("lang", "en"))
    vitana_id = metadata.get("vitana_id")
    is_mobile = bool(metadata.get("is_mobile", False))
    is_anonymous = bool(metadata.get("is_anonymous", False))

    # Mobile-community coercion (defense-in-depth, mirrors
    # feedback_mobile_community_only.md and orb-live.ts BOOTSTRAP-ORB-ROLE-SYNC-2)
    role = "community" if is_mobile else db_role

    if is_mobile and db_role != "community":
        logger.warning(
            "Mobile session for user_id=%s had db_role=%s — coerced to 'community' (defense-in-depth).",
            user_id,
            db_role,
        )

    return Identity(
        user_id=user_id,
        tenant_id=tenant_id,
        role=role,
        lang=lang,
        vitana_id=str(vitana_id) if vitana_id else None,
        is_mobile=is_mobile,
        is_anonymous=is_anonymous,
    )


def decode_jwt_unsafe(token: str) -> dict[str, Any]:
    """Decode a JWT without verifying — used only for inspection in tests.

    Production code path NEVER trusts a JWT decoded by this agent for auth
    decisions. The gateway has already authenticated and the agent reads
    pre-resolved identity from room metadata.
    """
    return pyjwt.decode(token, options={"verify_signature": False})
