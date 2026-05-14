"""Smoke tests: each module imports cleanly and exposes the expected surface."""
from __future__ import annotations


def test_config_imports() -> None:
    from src.orb_agent.config import AgentConfig

    assert AgentConfig is not None


def test_oasis_imports() -> None:
    from src.orb_agent.oasis import (
        DEFAULT_VTID,
        TOPIC_HANDOFF_COMPLETE,
        TOPIC_HANDOFF_START,
        TOPIC_PERSONA_SWAP,
        TOPIC_SESSION_START,
        TOPIC_SESSION_STOP,
        TOPIC_STALL_DETECTED,
        OasisEmitter,
    )

    assert OasisEmitter is not None
    # VTID-02986: session-lifecycle topics aligned to Vertex's vtid.live.*
    # namespace so Voice Lab's /api/v1/voice-lab/live/sessions endpoint
    # surfaces LiveKit sessions in the same panel as Vertex sessions.
    assert TOPIC_SESSION_START == "vtid.live.session.start"
    assert TOPIC_SESSION_STOP == "vtid.live.session.stop"
    assert TOPIC_STALL_DETECTED == "vtid.live.stall_detected"
    assert TOPIC_HANDOFF_START == "voice.handoff.start"
    assert TOPIC_HANDOFF_COMPLETE == "voice.handoff.complete"
    assert TOPIC_PERSONA_SWAP == "agent.voice.persona_swap"
    # VTID-02986: default VTID stamped on every emit so Voice Lab's vtid
    # IN-filter (voice-lab.ts:197) returns the row.
    assert DEFAULT_VTID == "VTID-LIVEKIT-AGENT"


def test_oasis_emitter_loud_on_missing_token(caplog) -> None:  # type: ignore[no-untyped-def]
    """VTID-02986: emitter must log WARN (not silent-return) when token is
    unset, so the missing-telemetry failure mode is visible in Cloud Run
    logs. The silent path is how livekit.stall_detected events disappeared
    during the 2026-05-14 disconnect investigation."""
    import asyncio
    import logging

    from src.orb_agent.oasis import OasisEmitter

    with caplog.at_level(logging.WARNING, logger="src.orb_agent.oasis"):
        emitter = OasisEmitter(gateway_url="https://example.test", service_token="")
        # Constructor-time WARN — operator sees this immediately at boot.
        assert any("GATEWAY_SERVICE_TOKEN not set" in r.message for r in caplog.records)
        caplog.clear()

        asyncio.run(emitter.emit(topic="vtid.live.session.start", payload={"x": 1}))
        # Per-emit WARN with the skipped topic name + reason.
        records = [r.message for r in caplog.records]
        assert any("oasis emit skipped (token_missing)" in m for m in records), records
        assert any("vtid.live.session.start" in m for m in records), records


def test_l22b1_lifecycle_topics() -> None:
    """L2.2b.1 (VTID-02987): the 5 new lifecycle topics MUST exist as
    module-level string literals, MUST use the `orb.livekit.agent.*` prefix,
    and MUST match the gateway-side CicdEventType union exactly."""
    from src.orb_agent.oasis import (
        TOPIC_AGENT_DISCONNECTED,
        TOPIC_AGENT_ROOM_JOIN_FAILED,
        TOPIC_AGENT_ROOM_JOIN_STARTED,
        TOPIC_AGENT_ROOM_JOIN_SUCCEEDED,
        TOPIC_AGENT_STARTING,
    )

    assert TOPIC_AGENT_STARTING == "orb.livekit.agent.starting"
    assert TOPIC_AGENT_ROOM_JOIN_STARTED == "orb.livekit.agent.room_join_started"
    assert TOPIC_AGENT_ROOM_JOIN_SUCCEEDED == "orb.livekit.agent.room_join_succeeded"
    assert TOPIC_AGENT_ROOM_JOIN_FAILED == "orb.livekit.agent.room_join_failed"
    assert TOPIC_AGENT_DISCONNECTED == "orb.livekit.agent.disconnected"

    # All 5 share the orb.livekit.agent.* prefix (gateway allowlist).
    for topic in [
        TOPIC_AGENT_STARTING,
        TOPIC_AGENT_ROOM_JOIN_STARTED,
        TOPIC_AGENT_ROOM_JOIN_SUCCEEDED,
        TOPIC_AGENT_ROOM_JOIN_FAILED,
        TOPIC_AGENT_DISCONNECTED,
    ]:
        assert topic.startswith("orb.livekit.agent."), topic


def test_l22b1_session_wires_lifecycle_topics() -> None:
    """session.py must reference all 5 lifecycle topics (the room-join
    proof loop) so they fire from the entrypoint. Structural / grep-style
    assertion — no livekit-agents SDK is invoked."""
    import pathlib

    session_src = (
        pathlib.Path(__file__).resolve().parent.parent
        / "src" / "orb_agent" / "session.py"
    ).read_text(encoding="utf-8")
    for topic_const in [
        "TOPIC_AGENT_STARTING",
        "TOPIC_AGENT_ROOM_JOIN_STARTED",
        "TOPIC_AGENT_ROOM_JOIN_SUCCEEDED",
        "TOPIC_AGENT_ROOM_JOIN_FAILED",
        "TOPIC_AGENT_DISCONNECTED",
    ]:
        assert topic_const in session_src, f"session.py is missing {topic_const}"


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
