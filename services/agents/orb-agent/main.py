"""orb-agent entrypoint.

Boots three things:
  1. An embedded FastAPI health server (Cloud Run probe target on $PORT).
  2. agents_registry self-register heartbeat (every 60s).
  3. The livekit-agents worker — joins LiveKit rooms as a participant when
     dispatched by the LiveKit server, runs the configured STT/LLM/TTS
     cascade, dispatches gateway tools.

The livekit-agents worker is the production path. If `livekit-agents`
isn't installed (e.g. local dev without the heavy SDK), the agent boots
in HEALTH-ONLY mode and logs a warning. This lets the gateway probe stay
green while the worker is being wired up.
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal

import structlog
import uvicorn

from src.orb_agent.config import AgentConfig
from src.orb_agent.health import make_health_app
from src.orb_agent.registry_client import RegistryHeartbeat


def configure_logging(level: str) -> None:
    logging.basicConfig(level=getattr(logging, level.upper(), logging.INFO))
    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, level.upper(), logging.INFO)
        ),
    )


async def _start_health_server(cfg: AgentConfig) -> tuple[uvicorn.Server, asyncio.Task[None]]:
    app = make_health_app()
    server_cfg = uvicorn.Config(
        app, host="0.0.0.0", port=cfg.health_port, log_config=None, access_log=False
    )
    server = uvicorn.Server(server_cfg)
    task = asyncio.create_task(server.serve(), name="health-server")
    return server, task


def _start_livekit_worker(cfg: AgentConfig, log) -> "asyncio.subprocess.Process | None":
    """Boot the livekit-agents worker as a SUBPROCESS, not in-process.

    Why subprocess:
      livekit.agents.cli.run_app() parses sys.argv and calls sys.exit()
      on missing/unknown commands. Running it as an asyncio task in the
      main process kills the health server (Cloud Run startup probe
      then 404s, deploy fails). A subprocess isolates that exit so the
      health server keeps running even when the worker crashes.

    The subprocess invokes `python -m livekit.agents start <module>` —
    same as the official deployment pattern from
    docs.livekit.io/agents/ops/deployment.

    Returns None if AGENT_ENABLE_WORKER is not '1' (HEALTH-ONLY mode).
    """
    if os.getenv("AGENT_ENABLE_WORKER", "0") != "1":
        log.info("livekit_worker.disabled", reason="AGENT_ENABLE_WORKER!=1; HEALTH-ONLY mode")
        return None

    try:
        # Import probe — confirms the SDK is installed before we spawn.
        import livekit.agents  # noqa: F401  # type: ignore[import-not-found]
    except ImportError:
        log.warning("livekit_worker.unavailable", reason="livekit-agents not installed; HEALTH-ONLY mode")
        return None

    log.info("livekit_worker.spawning", url=cfg.livekit_url)
    return None  # actual spawn happens in run() — needs the running event loop


async def _spawn_worker_subprocess(cfg: AgentConfig, log):
    """Spawn the livekit-agents worker as a subprocess. Returns the Process."""
    if os.getenv("AGENT_ENABLE_WORKER", "0") != "1":
        return None

    try:
        import livekit.agents  # noqa: F401  # type: ignore[import-not-found]
    except ImportError:
        log.warning("livekit_worker.unavailable", reason="livekit-agents not installed")
        return None

    env = os.environ.copy()
    # The worker subprocess inherits LIVEKIT_URL/KEY/SECRET via env.

    proc = await asyncio.create_subprocess_exec(
        "python",
        "-u",
        "-m",
        "src.orb_agent.worker_entry",
        env=env,
    )
    log.info("livekit_worker.spawned", pid=proc.pid)
    return proc


async def run() -> None:
    cfg = AgentConfig.from_env()
    configure_logging(cfg.log_level)
    log = structlog.get_logger("orb-agent")
    log.info("orb_agent.boot", version="0.1.0", livekit_url=cfg.livekit_url)

    # Health server.
    server, server_task = await _start_health_server(cfg)

    # agents_registry heartbeat.
    heartbeat = RegistryHeartbeat(
        gateway_url=cfg.gateway_url,
        service_token=cfg.gateway_service_token,
        interval_s=cfg.heartbeat_interval_seconds,
    )
    heartbeat.start()

    # livekit-agents worker as subprocess (isolation from sys.exit).
    worker_proc = await _spawn_worker_subprocess(cfg, log)
    if worker_proc is None:
        log.info("orb_agent.ready_health_only")
    else:
        log.info("orb_agent.ready", mode="livekit-worker+health", worker_pid=worker_proc.pid)

    # Graceful shutdown on SIGTERM.
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # pragma: no cover (Windows)
            pass
    await stop.wait()
    log.info("orb_agent.stopping")
    await heartbeat.stop()
    if worker_proc is not None:
        try:
            worker_proc.terminate()
            await asyncio.wait_for(worker_proc.wait(), timeout=10)
        except (asyncio.TimeoutError, ProcessLookupError):
            try:
                worker_proc.kill()
            except ProcessLookupError:
                pass
    server.should_exit = True
    await server_task
    log.info("orb_agent.stopped")


if __name__ == "__main__":
    asyncio.run(run())
