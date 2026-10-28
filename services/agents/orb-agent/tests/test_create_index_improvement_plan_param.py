"""Regression test for the target_pillar/pillar param-name mismatch.

create_index_improvement_plan's LiveKit wrapper used to send the dict key
`target_pillar` to the shared dispatcher, but the actual handler
(tool_create_index_improvement_plan in orb-tools-shared.ts) reads
`args.pillar`. The mismatch meant every LiveKit "make me a plan for
<pillar>" request silently ignored the requested pillar and fell back to
the user's weakest pillar instead — confirmed live on staging via a real
Vertex Live session asking for an "exercise" plan and getting a "nutrition"
plan back. Pin the correct key so this can't silently regress.
"""
from __future__ import annotations

import inspect
import pathlib


def _src() -> str:
    return (
        pathlib.Path(__file__).resolve().parent.parent
        / "src"
        / "orb_agent"
        / "tools.py"
    ).read_text(encoding="utf-8")


def test_dispatch_call_uses_pillar_key_not_target_pillar() -> None:
    src = _src()
    idx = src.index("async def create_index_improvement_plan")
    body = src[idx : idx + 400]
    assert '{"pillar": pillar}' in body, (
        "create_index_improvement_plan must dispatch with the dict key "
        "'pillar' — the handler (tool_create_index_improvement_plan in "
        "orb-tools-shared.ts) reads args.pillar, not args.target_pillar."
    )
    assert "target_pillar" not in body


def test_function_signature_param_is_named_pillar() -> None:
    from src.orb_agent.tools import create_index_improvement_plan

    params = list(inspect.signature(create_index_improvement_plan).parameters)
    assert "pillar" in params
    assert "target_pillar" not in params
