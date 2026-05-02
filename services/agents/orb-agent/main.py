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


def _start_livekit_worker(cfg: AgentConfig, log) -> asyncio.Task[None] | None:
    """Boot the livekit-agents worker in a background task.

    Returns None when the worker is intentionally skipped (env-flag opt-out
    or the SDK isn't installed). The agent process stays alive serving
    health checks; LiveKit room dispatch obviously won't work but the
    gateway probes remain green — fine for smoke-testing the deploy
    pipeline + the test-page room-join path.

    Set AGENT_ENABLE_WORKER=1 once we've validated the right embedding
    pattern for livekit-agents.cli.run_app (current concern: it parses
    sys.argv and may sys.exit, killing the health server with it).
    """
    if os.getenv("AGENT_ENABLE_WORKER", "0") != "1":
        log.info("livekit_worker.disabled", reason="AGENT_ENABLE_WORKER!=1; HEALTH-ONLY mode")
        return None

    try:
        from livekit.agents import WorkerOptions, cli  # type: ignore[import-not-found]
    except ImportError:
        log.warning("livekit_worker.unavailable", reason="livekit-agents not installed; HEALTH-ONLY mode")
        return None

    from src.orb_agent.session import agent_entrypoint

    opts = WorkerOptions(
        entrypoint_fnc=agent_entrypoint,
        ws_url=cfg.livekit_url,
        api_key=cfg.livekit_api_key,
        api_secret=cfg.livekit_api_secret,
    )

    async def _run() -> None:
        try:
            log.info("livekit_worker.starting", url=cfg.livekit_url)
            await cli.run_app(opts)
        except Exception as exc:  # noqa: BLE001
            log.error("livekit_worker.crashed", err=str(exc))

    return asyncio.create_task(_run(), name="livekit-worker")


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

    # livekit-agents worker (background).
    worker_task = _start_livekit_worker(cfg, log)
    if worker_task is None:
        log.info("orb_agent.ready_health_only")
    else:
        log.info("orb_agent.ready", mode="livekit-worker+health")

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
    if worker_task is not None:
        worker_task.cancel()
        try:
            await worker_task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
    server.should_exit = True
    await server_task
    log.info("orb_agent.stopped")


if __name__ == "__main__":
    asyncio.run(run())
