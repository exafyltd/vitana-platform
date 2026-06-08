"""VTID-03077: regression — sibling imports in src/orb_agent/*.py MUST use
the relative `from .X import ...` form.

The orb-agent worker is spawned by Cloud Run as
    python -m src.orb_agent.worker_entry
(see Dockerfile + worker_entry.py docstring) so at runtime the package
is `src.orb_agent`, NOT `orb_agent`. Any module that does
    from orb_agent.X import ...
raises ImportError at the first call site that hits it. When the call
site sits inside `agent_entrypoint` (as the VTID-03076 import did),
EVERY dispatched session dies silently between `cascade_built` and
`pre_start` — the user sees the agent join the room, then 5+ minutes
of dead air, then disconnects.

This test scans every src/orb_agent/*.py file and asserts no
`from orb_agent.` or `import orb_agent.` lines exist. If one is added
again, this fails BEFORE the regression hits production.

Why not just `from src.orb_agent.X`? That works too at runtime, but
mixes absolute-with-`src` and relative styles in the codebase. The
existing convention (top of session.py, providers.py, oasis.py) is
relative form. Lock it in.
"""
from __future__ import annotations

import pathlib
import re


def _orb_agent_dir() -> pathlib.Path:
    return pathlib.Path(__file__).resolve().parent.parent / "src" / "orb_agent"


def test_no_absolute_orb_agent_imports_in_source() -> None:
    """Reject `from orb_agent.X import ...` AND `import orb_agent.X` —
    both fail at runtime because the package is loaded as
    `src.orb_agent`. The regression check is purely textual; it doesn't
    need the SDK to run."""
    src_dir = _orb_agent_dir()
    offenders: list[tuple[str, int, str]] = []

    # Match lines that start a sibling-package import under the wrong root.
    # Allow `from .X` (relative) and `from src.orb_agent.X` (absolute
    # under the actual runtime path). Reject everything else that touches
    # `orb_agent.`.
    bad = re.compile(r"^\s*(?:from|import)\s+orb_agent[.\s]")

    for path in sorted(src_dir.glob("*.py")):
        for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            stripped = line.lstrip()
            # Skip comments — VTID-03077's own root-cause comment in
            # session.py mentions the bad pattern; that's documentation.
            if stripped.startswith("#"):
                continue
            if bad.match(line):
                offenders.append((path.name, line_no, line.strip()))

    assert not offenders, (
        "VTID-03077 regression — found `from orb_agent.X` / `import orb_agent.X` in "
        "src/orb_agent/. The worker process is launched as `python -m "
        "src.orb_agent.worker_entry`, so the bare `orb_agent.` root is not "
        "importable. Use the relative form `from .X import ...` instead.\n\n"
        "Offending lines:\n  "
        + "\n  ".join(f"{name}:{ln}  {src}" for name, ln, src in offenders)
    )


def test_continuation_intent_import_is_relative() -> None:
    """Pinpoint check for the specific regression that killed every
    session at 15:30-15:37 UTC on 2026-05-18. session.py MUST import
    continuation_intent via `from .continuation_intent import ...`."""
    sess = (_orb_agent_dir() / "session.py").read_text(encoding="utf-8")
    assert "from .continuation_intent import" in sess, (
        "session.py is missing the relative `from .continuation_intent import` form "
        "— VTID-03077 regression"
    )
    # The absolute form, if present outside a comment, would fail at runtime.
    for line_no, line in enumerate(sess.splitlines(), 1):
        if line.lstrip().startswith("#"):
            continue
        assert "from orb_agent.continuation_intent" not in line, (
            f"session.py:{line_no} re-introduced the absolute "
            f"`from orb_agent.continuation_intent` form — VTID-03077 regression"
        )
