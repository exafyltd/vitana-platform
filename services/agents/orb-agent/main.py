"""orb-agent entrypoint.

Boots two things:
  1. An embedded FastAPI health server (Cloud Run probe target on $PORT).
  2. The livekit-agents worker (when wired in the follow-up PR), which
     dials the configured LiveKit URL and waits for room dispatch.

Skeleton today: the worker isn't wired yet — main.py runs the health
server only, registers with agents_registry, and logs that it's standby.
This is sufficient for Cloud Run deploy + smoke tests to pass.
"""
from __future__ import annotations

import asyncio
import logging
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


async def run() -> None:
    cfg = AgentConfig.from_env()
    configure_logging(cfg.log_level)
    log = structlog.get_logger("orb-agent")
    log.info("orb-agent.boot", version="0.1.0", livekit_url=cfg.livekit_url)

    # Health server.
    app = make_health_app()
    server_cfg = uvicorn.Config(
        app, host="0.0.0.0", port=cfg.health_port, log_config=None, access_log=False
    )
    server = uvicorn.Server(server_cfg)
    server_task = asyncio.create_task(server.serve(), name="health-server")

    # agents_registry heartbeat.
    heartbeat = RegistryHeartbeat(
        gateway_url=cfg.gateway_url,
        service_token=cfg.gateway_service_token,
        interval_s=cfg.heartbeat_interval_seconds,
    )
    heartbeat.start()

    # TODO(VTID-LIVEKIT-FOUNDATION): wire livekit-agents worker here. Pseudocode:
    #
    #     from livekit.agents import WorkerOptions, cli
    #     from src.orb_agent.session import AgentSession
    #
    #     worker_opts = WorkerOptions(
    #         entrypoint_fnc=AgentSession.entrypoint,
    #         max_concurrent_jobs=10,
    #     )
    #     cli.run_app(worker_opts)
    #
    # For the skeleton, we just keep the health server alive.

    log.info("orb-agent.ready_skeleton", note="livekit worker not yet wired")

    # Graceful shutdown on SIGTERM.
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # pragma: no cover (Windows)
            pass
    await stop.wait()
    log.info("orb-agent.stopping")
    await heartbeat.stop()
    server.should_exit = True
    await server_task
    log.info("orb-agent.stopped")


if __name__ == "__main__":
    asyncio.run(run())
