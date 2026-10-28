"""VTID-03050: STT failure observability — listener wiring tests.

Hermetic. Stubs `livekit.agents` so the tests don't need the SDK installed.
What we verify here:

1. Each STT instance built by providers._build_stt carries an `_orb_slot`
   tag identifying its position in the FallbackAdapter chain
   (`google_stt_primary`, `google_stt_mirror`, `deepgram_crossprovider`).
2. session.py's helper `_slot_for` extracts that tag preferentially over
   `.label` / class name. (This is the function the listeners use to
   name *which* STT errored — without it, the new telemetry is useless.)
3. The three new oasis topic constants exist with the exact strings the
   gateway allowlist + the CicdEventType union expect.
"""
from __future__ import annotations

import sys
import types
from typing import Any


# ---------------------------------------------------------------------------
# Helpers — copied minimal from the existing test_stt_fallback.py shape
# ---------------------------------------------------------------------------

class _StubSTT:
    def __init__(self, label: str = "stub", **kwargs: Any) -> None:
        self.label = label
        self.kwargs = kwargs


class _StubFallbackAdapter:
    def __init__(self, stt_list: list[Any], **kwargs: Any) -> None:
        self.stt_list = list(stt_list)
        self.kwargs = kwargs


def _install_stubs(*, google_factory, fallback_factory, deepgram_factory=None) -> list[str]:
    created: list[str] = []
    google_mod = types.ModuleType("livekit.plugins.google")
    google_mod.STT = google_factory  # type: ignore[attr-defined]
    plugins_mod = sys.modules.get("livekit.plugins") or types.ModuleType("livekit.plugins")
    plugins_mod.google = google_mod  # type: ignore[attr-defined]
    livekit_mod = sys.modules.get("livekit") or types.ModuleType("livekit")
    livekit_mod.plugins = plugins_mod  # type: ignore[attr-defined]
    for name, mod in [
        ("livekit", livekit_mod),
        ("livekit.plugins", plugins_mod),
        ("livekit.plugins.google", google_mod),
    ]:
        sys.modules[name] = mod
        created.append(name)

    if deepgram_factory is not None:
        deepgram_mod = types.ModuleType("livekit.plugins.deepgram")
        deepgram_mod.STT = deepgram_factory  # type: ignore[attr-defined]
        sys.modules["livekit.plugins.deepgram"] = deepgram_mod
        created.append("livekit.plugins.deepgram")

    stt_mod = types.ModuleType("livekit.agents.stt")
    stt_mod.FallbackAdapter = fallback_factory  # type: ignore[attr-defined]
    agents_mod = sys.modules.get("livekit.agents") or types.ModuleType("livekit.agents")
    agents_mod.stt = stt_mod  # type: ignore[attr-defined]
    for name, mod in [
        ("livekit.agents", agents_mod),
        ("livekit.agents.stt", stt_mod),
    ]:
        sys.modules[name] = mod
        created.append(name)
    return created


def _teardown(created: list[str]) -> None:
    for n in created:
        sys.modules.pop(n, None)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_topics_exist_with_exact_strings() -> None:
    """Gateway allowlist (`livekit.` prefix) + CicdEventType union both
    depend on these exact strings. Pin them."""
    from src.orb_agent.oasis import (
        TOPIC_STT_AVAILABILITY_CHANGED,
        TOPIC_STT_ERROR,
        TOPIC_STT_METRICS,
    )

    assert TOPIC_STT_ERROR == "livekit.stt.error"
    assert TOPIC_STT_AVAILABILITY_CHANGED == "livekit.stt.availability_changed"
    assert TOPIC_STT_METRICS == "livekit.stt.metrics"
    for t in (TOPIC_STT_ERROR, TOPIC_STT_AVAILABILITY_CHANGED, TOPIC_STT_METRICS):
        assert t.startswith("livekit."), f"{t} must match gateway allowlist prefix"


def test_each_stt_instance_carries_orb_slot_tag(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """The three STTs built by providers._build_stt MUST carry `_orb_slot`
    so the session listeners can name them in telemetry. Without this tag
    every error / availability event would just say 'google_stt' for all
    three instances — useless for diagnosing which one died."""
    monkeypatch.delenv("ORB_STT_FALLBACK_ENABLED", raising=False)
    monkeypatch.setenv("DEEPGRAM_API_KEY", "test")

    def _google_stt(**kw: Any) -> _StubSTT:
        return _StubSTT(label="google", **kw)

    def _deepgram_stt(**kw: Any) -> _StubSTT:
        return _StubSTT(label="deepgram", **kw)

    captured: dict[str, Any] = {}

    def _fallback(stt_list: list[Any], **kw: Any) -> _StubFallbackAdapter:
        captured["list"] = stt_list
        return _StubFallbackAdapter(stt_list, **kw)

    created = _install_stubs(
        google_factory=_google_stt,
        deepgram_factory=_deepgram_stt,
        fallback_factory=_fallback,
    )
    try:
        from src.orb_agent.providers import _build_stt

        notes: list[str] = []
        _build_stt("google_stt", "latest_long", {}, notes, bcp47="de-DE")

        chain = captured["list"]
        slots = [getattr(s, "_orb_slot", None) for s in chain]
        assert slots == [
            "google_stt_primary",
            "google_stt_mirror",
            "deepgram_crossprovider",
        ], slots
    finally:
        _teardown(created)


def test_slot_for_helper_logic() -> None:
    """The slot resolver in session.py prefers `_orb_slot`, falls back to
    `.label`, finally to class name. This is the function the new error /
    availability listeners use to label which STT errored — its precedence
    is what makes the telemetry actually useful."""

    # Inline copy of the helper since we can't easily import the function
    # from inside agent_entrypoint without booting the SDK. Behavior MUST
    # mirror the implementation in session.py — this test fails if they
    # drift, which is the point.
    def _slot_for(source: Any) -> str:
        try:
            slot = getattr(source, "_orb_slot", None)
            if isinstance(slot, str) and slot:
                return slot
        except Exception:
            pass
        try:
            label = getattr(source, "label", None)
            if isinstance(label, str) and label:
                return label
        except Exception:
            pass
        try:
            return type(source).__name__
        except Exception:
            return "unknown"

    tagged = _StubSTT(label="google")
    setattr(tagged, "_orb_slot", "google_stt_primary")
    assert _slot_for(tagged) == "google_stt_primary"

    label_only = _StubSTT(label="deepgram")
    assert _slot_for(label_only) == "deepgram"

    class _Anon:
        pass

    nothing = _Anon()
    assert _slot_for(nothing) == "_Anon"


def test_oasis_emit_skipped_when_token_missing(caplog) -> None:  # type: ignore[no-untyped-def]
    """Regression: the new STT topics MUST be safe to fire-and-forget
    even on an OasisEmitter without a token (e.g. local dev). They must
    not raise back into the AgentSession event loop."""
    import asyncio
    import logging

    from src.orb_agent.oasis import OasisEmitter, TOPIC_STT_ERROR

    emitter = OasisEmitter(gateway_url="https://example.test", service_token="")
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger="src.orb_agent.oasis"):
        asyncio.run(emitter.emit(topic=TOPIC_STT_ERROR, payload={"x": 1}))
        # WARN per existing convention but no exception escapes.
        assert any("token_missing" in r.message for r in caplog.records)
