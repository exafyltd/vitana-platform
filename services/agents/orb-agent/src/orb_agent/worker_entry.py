"""Subprocess entry-point for the livekit-agents worker.

Spawned by main.py via `python -m src.orb_agent.worker_entry`. Isolated
from the parent process so that `cli.run_app()`'s sys.exit-on-bad-argv
doesn't kill the health server.

Sets argv to ['worker_entry', 'start'] before calling cli.run_app so the
livekit-agents CLI dispatcher receives a valid command instead of
inheriting whatever argv main.py was started with.
"""
from __future__ import annotations

import logging
import os
import sys


def _main() -> int:
    logging.basicConfig(
        level=getattr(logging, os.getenv("AGENT_LOG_LEVEL", "INFO").upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    log = logging.getLogger("orb-agent.worker_entry")
    log.info("worker_entry.boot")

    try:
        from livekit.agents import WorkerOptions, cli  # type: ignore[import-not-found]
    except ImportError:
        log.error("worker_entry.missing_livekit_agents")
        return 1

    try:
        from src.orb_agent.session import agent_entrypoint
    except ImportError as exc:
        log.error("worker_entry.import_session_failed", exc_info=exc)
        return 1

    livekit_url = os.environ.get("LIVEKIT_URL")
    api_key = os.environ.get("LIVEKIT_API_KEY")
    api_secret = os.environ.get("LIVEKIT_API_SECRET")
    if not (livekit_url and api_key and api_secret):
        log.error("worker_entry.missing_livekit_env")
        return 1

    opts = WorkerOptions(
        entrypoint_fnc=agent_entrypoint,
        ws_url=livekit_url,
        api_key=api_key,
        api_secret=api_secret,
    )

    # Force a valid CLI command so cli.run_app's argparse doesn't sys.exit.
    sys.argv = ["worker_entry", "start"]
    try:
        cli.run_app(opts)
    except SystemExit as exc:
        # cli.run_app SystemExits on shutdown — propagate code.
        return int(exc.code) if isinstance(exc.code, int) else 0
    except Exception:
        log.exception("worker_entry.crashed")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(_main())
