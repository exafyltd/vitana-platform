"""Smoke tests: each module imports cleanly and exposes the expected surface."""
from __future__ import annotations


def test_config_imports() -> None:
    from src.orb_agent.config import AgentConfig

    assert AgentConfig is not None


def test_oasis_imports() -> None:
    from src.orb_agent.oasis import (
        TOPIC_HANDOFF_COMPLETE,
        TOPIC_HANDOFF_START,
        TOPIC_PERSONA_SWAP,
        TOPIC_SESSION_START,
        TOPIC_SESSION_STOP,
        OasisEmitter,
    )

    assert OasisEmitter is not None
    # Topic strings must be the canonical literals from the parity spec.
    assert TOPIC_SESSION_START == "livekit.session.start"
    assert TOPIC_SESSION_STOP == "livekit.session.stop"
    assert TOPIC_HANDOFF_START == "voice.handoff.start"
    assert TOPIC_HANDOFF_COMPLETE == "voice.handoff.complete"
    assert TOPIC_PERSONA_SWAP == "agent.voice.persona_swap"


def test_instructions_signatures() -> None:
    """The signatures of build_live / build_anonymous match the parity spec."""
    import inspect

    from src.orb_agent.instructions import (
        build_anonymous_system_instruction,
        build_live_system_instruction,
    )

    auth_params = list(inspect.signature(build_live_system_instruction).parameters.keys())
    anon_params = list(inspect.signature(build_anonymous_system_instruction).parameters.keys())

    expected_auth = [
        "lang",
        "voice_style",
        "bootstrap_context",
        "active_role",
        "conversation_summary",
        "conversation_history",
        "is_reconnect",
        "last_session_info",
        "current_route",
        "recent_routes",
        "client_context",
        "vitana_id",
    ]
    expected_anon = ["lang", "voice_style", "ctx", "conversation_history", "is_reconnect"]

    assert auth_params == expected_auth, f"build_live signature drift: {auth_params}"
    assert anon_params == expected_anon, f"build_anonymous signature drift: {anon_params}"


def test_navigator_surface_classification() -> None:
    from src.orb_agent.navigator import classify_surface

    assert classify_surface("/admin/feedback/specialists") == "admin"
    assert classify_surface("/command-hub/diagnostics") == "developer"
    assert classify_surface("/comm/find-partner") == "community"
    assert classify_surface("/discover/marketplace") == "community"
    assert classify_surface("/some/random") == "unknown"


def test_navigator_cross_surface_blocked() -> None:
    import pytest

    from src.orb_agent.navigator import assert_route_in_surface

    # Crossing community → admin must raise.
    with pytest.raises(ValueError):
        assert_route_in_surface("/admin/feedback/specialists", "community")
    # Same-surface is fine.
    assert_route_in_surface("/comm/find-partner", "community")


def test_identity_mobile_coercion() -> None:
    """Mobile session with developer DB role must coerce to community."""
    from src.orb_agent.identity import resolve_identity_from_room_metadata

    ident = resolve_identity_from_room_metadata({
        "user_id": "u1",
        "tenant_id": "t1",
        "role": "developer",
        "lang": "en",
        "is_mobile": True,
    })
    assert ident.role == "community", "mobile must coerce to community"

    ident_desktop = resolve_identity_from_room_metadata({
        "user_id": "u2",
        "tenant_id": "t1",
        "role": "developer",
        "lang": "en",
        "is_mobile": False,
    })
    assert ident_desktop.role == "developer"


def test_health_app_returns_ok() -> None:
    from fastapi.testclient import TestClient

    from src.orb_agent.health import make_health_app

    app = make_health_app()
    client = TestClient(app)
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["service"] == "orb-agent"
    assert "providers" in body
