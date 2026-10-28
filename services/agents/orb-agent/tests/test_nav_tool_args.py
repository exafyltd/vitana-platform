"""VTID-04881 — the LiveKit navigation wrappers send what the gateway needs.

Before this, the LiveKit `navigate` wrapper sent no `intent`, and the gateway
(orb-tools-shared.ts) treats a missing intent as "where", so "open my wallet"
never opened anything on this pipeline. `navigate_to_screen` sent only
`target`, so every screen about one item (a conversation, a group, a profile,
a match) failed with missing_param. No wrapper sent the member's own words or
language. These tests pin the exact request each wrapper sends.

Runs locally (`pytest services/agents/orb-agent/tests`); no CI job runs the
orb-agent suite.
"""
from __future__ import annotations

import inspect
import json
import pathlib
from typing import Any

import pytest

from src.orb_agent import tools
from src.orb_agent.gateway_client import GatewayClient


class FakeGateway(GatewayClient):
    def __init__(self, response: dict[str, Any] | None = None) -> None:
        super().__init__("http://gateway.test", "jwt")
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.response = response or {"ok": True, "result": {}}

    async def post(self, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        self.calls.append((path, body or {}))
        return self.response


class Ctx:
    def __init__(self, gw: GatewayClient) -> None:
        self.userdata = gw


def make_gw(**kw: Any) -> FakeGateway:
    gw = FakeGateway(kw.pop("response", None))
    gw.current_route = "/home"
    gw.recent_routes = ["/inbox"]
    gw.is_mobile = kw.pop("is_mobile", False)
    gw.is_anonymous = False
    gw.identity_lang = kw.pop("lang", "de")
    gw.last_user_text = kw.pop("words", None)
    return gw


def sent(gw: FakeGateway) -> dict[str, Any]:
    assert len(gw.calls) == 1
    path, body = gw.calls[0]
    assert path == "/api/v1/orb/tool"
    return body


# ── navigate ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "given, expected",
    [("open", "open"), ("OPEN ", "open"), ("where", "where"), ("", "where"), ("maybe", "where")],
)
async def test_navigate_sends_intent_with_the_gateway_default(given: str, expected: str) -> None:
    gw = make_gw()
    await tools.navigate(Ctx(gw), "zeig mir mein Wallet", given)
    body = sent(gw)
    assert body["name"] == "navigate"
    assert body["args"]["intent"] == expected


async def test_navigate_sends_viewport_identity_and_member_words() -> None:
    gw = make_gw(is_mobile=True, words="  öffne bitte mein Wallet  ")
    await tools.navigate(Ctx(gw), "öffne mein Wallet", "open")
    body = sent(gw)
    assert body["lang"] == "de"
    assert body["args"] == {
        "question": "öffne mein Wallet",
        "intent": "open",
        "current_route": "/home",
        "recent_routes": ["/inbox"],
        "is_mobile": True,
        "is_anonymous": False,
        "transcript_excerpt": "öffne bitte mein Wallet",
    }


def test_navigate_intent_is_required() -> None:
    params = inspect.signature(tools.navigate).parameters
    assert params["intent"].default is inspect.Parameter.empty
    assert params["question"].default is inspect.Parameter.empty


# ── navigate_to_screen ─────────────────────────────────────────────────────

async def test_screen_id_and_entity_ids_are_forwarded_under_gateway_names() -> None:
    gw = make_gw()
    await tools.navigate_to_screen(Ctx(gw), screen_id="COMM.GROUP_DETAIL", groupId=" g-7 ", reason="the group")
    args = sent(gw)["args"]
    assert args["screen_id"] == "COMM.GROUP_DETAIL"
    assert args["groupId"] == "g-7"
    assert args["reason"] == "the group"
    assert "target" not in args
    # Empty ids are not sent: the gateway must see "missing", never "".
    for name in tools.NAVIGATE_TO_SCREEN_ENTITY_ARGS:
        if name != "groupId":
            assert name not in args


@pytest.mark.parametrize("name", tools.NAVIGATE_TO_SCREEN_ENTITY_ARGS)
async def test_every_entity_id_is_forwarded(name: str) -> None:
    gw = make_gw()
    await tools.navigate_to_screen(Ctx(gw), screen_id="X", **{name: "v-1"})
    assert sent(gw)["args"][name] == "v-1"


async def test_legacy_target_only_still_works() -> None:
    gw = make_gw()
    await tools.navigate_to_screen(Ctx(gw), target="INBOX.OVERVIEW")
    args = sent(gw)["args"]
    assert args["target"] == "INBOX.OVERVIEW"
    assert "screen_id" not in args
    assert args["current_route"] == "/home"


async def test_member_words_and_keep_orb_open_are_forwarded() -> None:
    gw = make_gw(words="x" * 900)
    await tools.navigate_to_screen(Ctx(gw), screen_id="INBOX.OVERVIEW", keep_orb_open=True)
    args = sent(gw)["args"]
    assert args["keep_orb_open"] is True
    assert args["transcript_excerpt"] == "x" * 500


def test_every_extra_parameter_is_optional() -> None:
    params = inspect.signature(tools.navigate_to_screen).parameters
    extras = [p for n, p in params.items() if n != "context"]
    assert extras and all(p.default is not inspect.Parameter.empty for p in extras)
    assert set(tools.NAVIGATE_TO_SCREEN_ENTITY_ARGS) <= set(params)


def test_entity_args_cover_every_param_the_registry_needs() -> None:
    """Every :param in a registry route or overlay maps to a forwarded name."""
    screens = (
        pathlib.Path(__file__).resolve().parents[5]
        / "vitana-v1"
        / "src"
        / "navigation"
        / "registry"
        / "screens.json"
    )
    if not screens.exists():
        pytest.skip("vitana-v1 checkout not next to vitana-platform")
    # Gateway aliases (nav-dispatch.ts ENTITY_ARG_ALIASES): registry name -> a
    # name the tool schema uses.
    alias = {"id@COMM.GROUP_DETAIL": "groupId", "id@INTENTS.MATCH_DETAIL": "match_id", "identifier": "vitana_id"}
    needed: set[str] = set()
    import re

    for s in json.loads(screens.read_text(encoding="utf-8"))["screens"]:
        names = set(re.findall(r":([a-zA-Z_][a-zA-Z0-9_]*)", s.get("route", "")))
        if s.get("overlay", {}).get("param"):
            names.add(s["overlay"]["param"])
        for n in names:
            needed.add(alias.get(f"{n}@{s['id']}") or alias.get(n) or n)
    missing = needed - set(tools.NAVIGATE_TO_SCREEN_ENTITY_ARGS)
    assert not missing, f"registry params with no forwarded argument: {sorted(missing)}"


# ── shared request body and route tracking ─────────────────────────────────

async def test_every_tool_sends_the_language_but_never_a_session_id() -> None:
    gw = make_gw(lang="sr")
    gw.orb_session_id = "sess-1"
    await tools.get_current_screen(Ctx(gw))
    body = sent(gw)
    assert body["lang"] == "sr"
    assert "session_id" not in body
    assert "session_id" not in body["args"]


async def test_no_language_no_lang_field() -> None:
    gw = make_gw(lang=None)
    await tools.get_current_screen(Ctx(gw))
    assert "lang" not in sent(gw)


@pytest.mark.parametrize(
    "result, current, trail",
    [
        ({"route": "/wallet?tab=x", "base_route": "/wallet"}, "/wallet", ["/home", "/inbox"]),
        ({"route": "/news?x=1"}, "/news", ["/home", "/inbox"]),
        ({"route": "/home?open=meetup", "entry_kind": "overlay"}, "/home", ["/inbox"]),
        ({"route": "/wallet", "already_there": True}, "/home", ["/inbox"]),
        ({"decision": "offer"}, "/home", ["/inbox"]),
    ],
)
async def test_both_wrappers_track_the_page_the_same_way(result: dict[str, Any], current: str, trail: list[str]) -> None:
    for call in (
        lambda ctx: tools.navigate(ctx, "q", "open"),
        lambda ctx: tools.navigate_to_screen(ctx, screen_id="S"),
    ):
        gw = make_gw(response={"ok": True, "result": result})
        await call(Ctx(gw))
        assert gw.current_route == current
        assert gw.recent_routes == trail


# ── the real LiveKit schema, when the package is installed ─────────────────

def test_livekit_schema_marks_extras_optional() -> None:
    pytest.importorskip("livekit.agents")
    from livekit.agents.llm import utils as llm_utils  # type: ignore

    build = getattr(llm_utils, "build_legacy_openai_schema", None) or getattr(llm_utils, "build_strict_openai_schema", None)
    if build is None:
        pytest.skip("this livekit-agents version exposes no schema builder")
    schema = json.dumps(build(tools.navigate_to_screen))
    assert "recipient_id" in schema and "groupId" in schema
