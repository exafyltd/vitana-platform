"""VTID-03037: STT FallbackAdapter wiring in providers._build_stt.

Tests are hermetic — they stub `livekit.plugins.google` and
`livekit.agents.stt` via sys.modules so the test env doesn't have to
have the real plugins installed. Each test sets up its own stubs and
tears them down in a finally block.
"""
from __future__ import annotations

import sys
import types
from typing import Any


# ---------------------------------------------------------------------------
# Stub plumbing — installed/removed per-test so cases don't leak.
# ---------------------------------------------------------------------------

class _StubSTT:
    """Stand-in for a livekit-agents STT instance. Distinguishable by .label."""

    def __init__(self, label: str, **kwargs: Any) -> None:
        self.label = label
        self.kwargs = kwargs


class _StubFallbackAdapter:
    """Stand-in for livekit.agents.stt.FallbackAdapter. Records the list +
    constructor kwargs so the test can assert on them."""

    def __init__(self, stt_list: list[Any], **kwargs: Any) -> None:
        self.stt_list = list(stt_list)
        self.kwargs = kwargs
        self.is_fallback_adapter = True


def _install_stubs(
    *,
    google_factory=None,
    deepgram_factory=None,
    fallback_factory=None,
) -> dict[str, Any]:
    """Install fake livekit.plugins.google / .deepgram / livekit.agents.stt
    modules. Returns the list of module-name keys we created so the caller
    can tear them down."""
    created: list[str] = []

    if google_factory is not None:
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
            if name not in sys.modules:
                sys.modules[name] = mod
                created.append(name)
            elif name == "livekit.plugins.google":
                sys.modules[name] = mod
                created.append(name)

    if deepgram_factory is not None:
        deepgram_mod = types.ModuleType("livekit.plugins.deepgram")
        deepgram_mod.STT = deepgram_factory  # type: ignore[attr-defined]
        sys.modules["livekit.plugins.deepgram"] = deepgram_mod
        created.append("livekit.plugins.deepgram")

    if fallback_factory is not None:
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

    return {"created": created}


def _teardown_stubs(state: dict[str, Any]) -> None:
    for name in state["created"]:
        sys.modules.pop(name, None)


def _reset_module_cache() -> None:
    """providers.py imports `os` and reads env on each call, so no per-test
    cache to wipe. We do, however, want to drop any cached `livekit.plugins.X`
    submodules from previous tests."""
    for name in [
        "livekit.plugins.google",
        "livekit.plugins.deepgram",
        "livekit.agents.stt",
        "livekit.agents",
    ]:
        sys.modules.pop(name, None)


# ---------------------------------------------------------------------------
# Env-flag parsing.
# ---------------------------------------------------------------------------

def test_fallback_enabled_default_true(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.delenv("ORB_STT_FALLBACK_ENABLED", raising=False)
    from src.orb_agent.providers import _fallback_enabled

    assert _fallback_enabled() is True


def test_fallback_enabled_kill_switch_variants(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    from src.orb_agent.providers import _fallback_enabled

    for off in ["false", "False", "FALSE", "0", "no", "off"]:
        monkeypatch.setenv("ORB_STT_FALLBACK_ENABLED", off)
        assert _fallback_enabled() is False, off

    for on in ["true", "True", "1", "yes", "on", ""]:
        monkeypatch.setenv("ORB_STT_FALLBACK_ENABLED", on)
        assert _fallback_enabled() is True, on


def test_fallback_attempt_timeout_default_8s(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.delenv("ORB_STT_FALLBACK_ATTEMPT_TIMEOUT_MS", raising=False)
    from src.orb_agent.providers import _fallback_attempt_timeout_s

    assert _fallback_attempt_timeout_s() == 8.0


def test_fallback_attempt_timeout_parsed(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    from src.orb_agent.providers import _fallback_attempt_timeout_s

    monkeypatch.setenv("ORB_STT_FALLBACK_ATTEMPT_TIMEOUT_MS", "5000")
    assert _fallback_attempt_timeout_s() == 5.0

    # Bogus values fall back to default — agent must not crash on a typo.
    monkeypatch.setenv("ORB_STT_FALLBACK_ATTEMPT_TIMEOUT_MS", "not-a-number")
    assert _fallback_attempt_timeout_s() == 8.0

    # Floor at 1.0s so a 0 doesn't disable the adapter's internal timer.
    monkeypatch.setenv("ORB_STT_FALLBACK_ATTEMPT_TIMEOUT_MS", "0")
    assert _fallback_attempt_timeout_s() == 1.0


# ---------------------------------------------------------------------------
# Wrapping behavior.
# ---------------------------------------------------------------------------

def test_build_stt_wraps_in_fallback_adapter_when_enabled(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """Default path: provider builds OK, mirror builds OK, FallbackAdapter
    wraps the pair. Verifies attempt_timeout is the env-configured value."""
    monkeypatch.delenv("ORB_STT_FALLBACK_ENABLED", raising=False)
    monkeypatch.setenv("ORB_STT_FALLBACK_ATTEMPT_TIMEOUT_MS", "8000")
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    _reset_module_cache()

    counter = {"n": 0}

    def _google_stt(**kwargs: Any) -> _StubSTT:
        counter["n"] += 1
        return _StubSTT(label=f"google-{counter['n']}", **kwargs)

    captured: list[_StubFallbackAdapter] = []

    def _adapter(stt_list: list[Any], **kwargs: Any) -> _StubFallbackAdapter:
        a = _StubFallbackAdapter(stt_list, **kwargs)
        captured.append(a)
        return a

    state = _install_stubs(google_factory=_google_stt, fallback_factory=_adapter)
    try:
        from src.orb_agent.providers import _build_stt

        notes: list[str] = []
        result = _build_stt("google_stt", "latest_long", {}, notes, bcp47="de-DE")

        assert getattr(result, "is_fallback_adapter", False), \
            f"expected FallbackAdapter, got {result!r}"
        assert len(captured) == 1
        adapter = captured[0]
        assert len(adapter.stt_list) == 2, "primary + same-provider mirror"
        assert all(isinstance(s, _StubSTT) for s in adapter.stt_list)
        # Each instance is distinct (fresh connections).
        assert adapter.stt_list[0] is not adapter.stt_list[1]
        # Both got the right language injection.
        for s in adapter.stt_list:
            assert s.kwargs["languages"] == ["de-DE"]
            assert s.kwargs["model"] == "latest_long"
        # Adapter constructor args match the env-configured timeout.
        assert adapter.kwargs["attempt_timeout"] == 8.0
        assert adapter.kwargs["max_retry_per_stt"] == 1
        assert adapter.kwargs["retry_interval"] == 5.0
        # Notes record the wrapping for telemetry/debugging.
        assert any("same-provider mirror" in n for n in notes), notes
        assert any("FallbackAdapter" in n for n in notes), notes
    finally:
        _teardown_stubs(state)
        _reset_module_cache()


def test_build_stt_includes_deepgram_when_key_present(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """When DEEPGRAM_API_KEY is set and primary is google, the wrapper
    includes a cross-provider Deepgram fallback (third instance)."""
    monkeypatch.delenv("ORB_STT_FALLBACK_ENABLED", raising=False)
    monkeypatch.setenv("DEEPGRAM_API_KEY", "test-key")
    _reset_module_cache()

    def _google_stt(**kwargs: Any) -> _StubSTT:
        return _StubSTT(label="google", **kwargs)

    def _deepgram_stt(**kwargs: Any) -> _StubSTT:
        return _StubSTT(label="deepgram", **kwargs)

    captured: list[_StubFallbackAdapter] = []

    def _adapter(stt_list: list[Any], **kwargs: Any) -> _StubFallbackAdapter:
        a = _StubFallbackAdapter(stt_list, **kwargs)
        captured.append(a)
        return a

    state = _install_stubs(
        google_factory=_google_stt,
        deepgram_factory=_deepgram_stt,
        fallback_factory=_adapter,
    )
    try:
        from src.orb_agent.providers import _build_stt

        notes: list[str] = []
        result = _build_stt("google_stt", "latest_long", {}, notes, bcp47="en-US")

        assert getattr(result, "is_fallback_adapter", False)
        adapter = captured[0]
        assert len(adapter.stt_list) == 3
        labels = [s.label for s in adapter.stt_list]
        assert labels == ["google", "google", "deepgram"], labels
        assert any("cross-provider deepgram" in n for n in notes), notes
    finally:
        _teardown_stubs(state)
        _reset_module_cache()


def test_build_stt_kill_switch_returns_single_instance(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """ORB_STT_FALLBACK_ENABLED=false short-circuits to current behavior:
    one STT, no FallbackAdapter wrapping, no second instance built."""
    monkeypatch.setenv("ORB_STT_FALLBACK_ENABLED", "false")
    _reset_module_cache()

    call_count = {"n": 0}

    def _google_stt(**kwargs: Any) -> _StubSTT:
        call_count["n"] += 1
        return _StubSTT(label=f"google-{call_count['n']}", **kwargs)

    # FallbackAdapter must NOT be invoked.
    def _adapter(stt_list: list[Any], **kwargs: Any) -> _StubFallbackAdapter:
        raise AssertionError("FallbackAdapter must not be constructed when kill switch is on")

    state = _install_stubs(google_factory=_google_stt, fallback_factory=_adapter)
    try:
        from src.orb_agent.providers import _build_stt

        notes: list[str] = []
        result = _build_stt("google_stt", None, {}, notes, bcp47="en-US")

        assert isinstance(result, _StubSTT)
        assert call_count["n"] == 1, "only the primary should be built when fallback is off"
    finally:
        _teardown_stubs(state)
        _reset_module_cache()


def test_build_stt_returns_primary_when_mirror_fails(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """If only the primary can be built (mirror raises, no Deepgram key)
    we return the primary unwrapped — wrapping a single STT adds latency
    with no resilience benefit."""
    monkeypatch.delenv("ORB_STT_FALLBACK_ENABLED", raising=False)
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    _reset_module_cache()

    call_count = {"n": 0}

    def _flaky_google(**kwargs: Any) -> _StubSTT:
        call_count["n"] += 1
        if call_count["n"] == 1:
            return _StubSTT(label="primary", **kwargs)
        raise RuntimeError("simulated mirror init failure")

    def _adapter(stt_list: list[Any], **kwargs: Any) -> _StubFallbackAdapter:
        raise AssertionError("must not wrap a single-instance list")

    state = _install_stubs(google_factory=_flaky_google, fallback_factory=_adapter)
    try:
        from src.orb_agent.providers import _build_stt

        notes: list[str] = []
        result = _build_stt("google_stt", None, {}, notes, bcp47="en-US")

        assert isinstance(result, _StubSTT)
        assert result.label == "primary"
        assert any("only 1 instance built" in n for n in notes), notes
    finally:
        _teardown_stubs(state)
        _reset_module_cache()


def test_build_stt_returns_none_when_primary_fails(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """When the primary itself can't be built we return None — same as
    the pre-VTID-03037 behavior. The cascade.notes carry the reason."""
    monkeypatch.delenv("ORB_STT_FALLBACK_ENABLED", raising=False)
    _reset_module_cache()

    # No livekit.plugins.google stub installed → ImportError path.
    from src.orb_agent.providers import _build_stt

    notes: list[str] = []
    result = _build_stt("google_stt", None, {}, notes, bcp47="en-US")
    assert result is None
    assert any("not installed" in n for n in notes), notes


def test_build_stt_falls_back_to_primary_when_adapter_import_fails(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """If livekit.agents.stt.FallbackAdapter is unavailable (older SDK)
    we DON'T crash — we return the primary unwrapped. Same outcome as
    the kill switch path, but reached at runtime instead of via env."""
    monkeypatch.delenv("ORB_STT_FALLBACK_ENABLED", raising=False)
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    _reset_module_cache()

    def _google_stt(**kwargs: Any) -> _StubSTT:
        return _StubSTT(label="google", **kwargs)

    state = _install_stubs(google_factory=_google_stt)  # no fallback adapter stub
    try:
        from src.orb_agent.providers import _build_stt

        notes: list[str] = []
        result = _build_stt("google_stt", None, {}, notes, bcp47="en-US")
        assert isinstance(result, _StubSTT)
        assert any("FallbackAdapter unavailable" in n for n in notes), notes
    finally:
        _teardown_stubs(state)
        _reset_module_cache()


def test_build_stt_strips_row_seeded_language_keys() -> None:
    """Both the primary AND the mirror must get a clean opts dict — the
    row-seeded `language`/`languages`/`voices_per_lang` keys are
    stripped before construction so they can't collide with the BCP-47
    we inject. PR 1.B-Lang-4 invariant; this test re-asserts it for
    the post-VTID-03037 call path."""
    _reset_module_cache()

    seen_kwargs: list[dict[str, Any]] = []

    def _google_stt(**kwargs: Any) -> _StubSTT:
        seen_kwargs.append(dict(kwargs))
        return _StubSTT(label="google", **kwargs)

    def _adapter(stt_list: list[Any], **kwargs: Any) -> _StubFallbackAdapter:
        return _StubFallbackAdapter(stt_list, **kwargs)

    state = _install_stubs(google_factory=_google_stt, fallback_factory=_adapter)
    try:
        from src.orb_agent.providers import _build_stt

        notes: list[str] = []
        _build_stt(
            "google_stt",
            "latest_long",
            # Row-seeded keys that must NOT leak into the plugin kwargs:
            {
                "language": "en-US",        # legacy single-lang key
                "languages": ["en-US"],     # google-style multi-lang
                "voices_per_lang": {"de": "x"},  # TTS-only, dropped defensively
            },
            notes,
            bcp47="de-DE",
        )

        assert len(seen_kwargs) == 2, "primary + mirror"
        for kw in seen_kwargs:
            # bcp47 injection wins.
            assert kw["languages"] == ["de-DE"]
            # All three stripped keys are absent.
            assert "language" not in kw
            assert "voices_per_lang" not in kw
    finally:
        _teardown_stubs(state)
        _reset_module_cache()
