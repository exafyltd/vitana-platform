"""Navigator surface scoping helpers.

Per memory/feedback_navigator_surface_scoping.md: the ORB Navigator must
scope to the active surface — vitanaland → community, /admin/* → admin,
/command-hub/* → developer. Never cross surfaces.

This module exposes:
  - classify_surface(route) — derive surface from a path
  - assert_route_in_surface(route, current_surface) — raises ValueError on
    cross-surface, used by the navigate tool wrapper to reject bad routes.

The actual `navigate` and `get_current_screen` @function_tools live in
tools.py and call into these helpers.
"""
from __future__ import annotations

from typing import Literal

Surface = Literal["community", "admin", "developer", "unknown"]


def classify_surface(route: str) -> Surface:
    """Map a path to its surface."""
    r = route.strip()
    if r.startswith("/admin"):
        return "admin"
    if r.startswith("/command-hub"):
        return "developer"
    if r.startswith("/comm") or r.startswith("/health") or r.startswith("/intents") or r == "/":
        return "community"
    if r.startswith("/discover") or r.startswith("/profile") or r.startswith("/wallet"):
        return "community"
    return "unknown"


def assert_route_in_surface(route: str, current_surface: Surface) -> None:
    """Raise ValueError if `route` is in a different surface than the user is in.

    Called by the navigate @function_tool. The error message is returned to
    the LLM so it can apologize naturally instead of producing a broken
    cross-surface redirect.
    """
    target_surface = classify_surface(route)
    if target_surface == "unknown":
        # Unknown is not a violation — let the gateway decide.
        return
    if target_surface != current_surface:
        raise ValueError(
            f"Cross-surface navigation rejected: cannot route to {target_surface} surface "
            f"(route={route}) from {current_surface} surface."
        )
