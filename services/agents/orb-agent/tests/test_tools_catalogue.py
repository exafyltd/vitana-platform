"""Tests that the tool catalogue matches voice-pipeline-spec/spec.json.

This is the parity contract enforced from the Python side. The CI parity
scanner does the static AST walk; these tests do the dynamic-import check.
Both should agree.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
SPEC = REPO_ROOT / "voice-pipeline-spec" / "spec.json"


def _load_spec_tools() -> set[str]:
    if not SPEC.exists():
        pytest.skip(f"spec.json not found at {SPEC} (run from a checkout that includes voice-pipeline-spec/)")
    with SPEC.open() as f:
        spec = json.load(f)
    return {t["name"] for t in spec["tools"]}


def test_all_tool_names_exported() -> None:
    """tools.all_tool_names() ∪ DEFERRED_TOOL_NAMES must equal spec.json's tool
    list (the parity contract); skeleton must not have anything extra.

    DEFERRED_TOOL_NAMES is the explicit "endpoint not yet wired on the
    gateway" list. Each entry there has its Vertex implementation inline
    in orb-live.ts and lands in a follow-up PR. Keeping them in spec.json
    preserves parity-contract awareness while letting `all_tools()` ship
    only the working subset to the LLM.
    """
    from src.orb_agent.tools import DEFERRED_TOOL_NAMES, all_tool_names

    spec_tools = _load_spec_tools()
    active = set(all_tool_names())
    deferred = set(DEFERRED_TOOL_NAMES)
    overlap = active & deferred
    assert not overlap, f"tools cannot be both active and deferred: {overlap}"
    union = active | deferred
    missing = spec_tools - union
    extra = union - spec_tools
    assert not missing, f"spec declares tools missing from skeleton (active or deferred): {missing}"
    assert not extra, f"skeleton has tools not in spec: {extra}"


def test_tool_decorators_present() -> None:
    """Every tool name must resolve to a callable in tools module."""
    import src.orb_agent.tools as tools_mod
    from src.orb_agent.tools import all_tool_names

    for name in all_tool_names():
        fn = getattr(tools_mod, name, None)
        assert callable(fn), f"tool {name!r} not exported as callable in tools.py"
