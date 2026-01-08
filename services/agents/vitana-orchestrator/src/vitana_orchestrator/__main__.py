"""
Vitana Orchestrator CLI

VTID: VTID-01175

Command-line interface for the orchestrator.
"""

import argparse
import asyncio
import os
import sys
from pathlib import Path
from typing import Optional

from . import VitanaOrchestrator, OrchestratorConfig, TaskConfig, __version__, __vtid__
from .adapters import ClaudeAdapter, CrewAIAdapter, MockAdapter
from .logging_config import setup_logging
from .metrics import get_metrics
from .output.console import ConsoleFormatter, print_banner, OutputLevel
from .main import TaskDomain


def parse_args() -> argparse.Namespace:
    """Parse command line arguments"""
    parser = argparse.ArgumentParser(
        prog="vitana-orchestrator",
        description="Vitana Orchestrator - Guaranteed task completion with verification",
    )

    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__} ({__vtid__})",
    )

    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # Run command
    run_parser = subparsers.add_parser("run", help="Execute a task")
    run_parser.add_argument("vtid", help="VTID of the task")
    run_parser.add_argument("title", help="Task title")
    run_parser.add_argument("--description", "-d", help="Task description")
    run_parser.add_argument(
        "--domain",
        choices=["frontend", "backend", "memory", "mixed"],
        help="Task domain (auto-detected if not specified)",
    )
    run_parser.add_argument(
        "--target",
        "-t",
        action="append",
        dest="targets",
        help="Target file patterns",
    )
    run_parser.add_argument(
        "--adapter",
        choices=["claude", "crewai", "mock"],
        default="claude",
        help="Agent adapter to use",
    )
    run_parser.add_argument(
        "--no-verify",
        action="store_true",
        help="Skip verification (not recommended)",
    )
    run_parser.add_argument(
        "--max-retries",
        type=int,
        default=3,
        help="Maximum retry attempts",
    )

    # Status command
    status_parser = subparsers.add_parser("status", help="Show orchestrator status")
    status_parser.add_argument("--task-id", help="Show specific task status")

    # Config command
    config_parser = subparsers.add_parser("config", help="Show/edit configuration")
    config_parser.add_argument("--show", action="store_true", help="Show current config")
    config_parser.add_argument("--init", action="store_true", help="Initialize config file")

    # Global options
    parser.add_argument(
        "--verbose", "-v",
        action="count",
        default=0,
        help="Increase verbosity",
    )
    parser.add_argument(
        "--quiet", "-q",
        action="store_true",
        help="Quiet mode",
    )
    parser.add_argument(
        "--log-file",
        help="Log to file",
    )
    parser.add_argument(
        "--config",
        help="Config file path",
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        help="Disable colored output",
    )

    return parser.parse_args()


async def run_task(args: argparse.Namespace, formatter: ConsoleFormatter) -> int:
    """Execute a task"""
    # Load config
    if args.config and Path(args.config).exists():
        config = OrchestratorConfig.from_yaml(args.config)
    else:
        config = OrchestratorConfig.from_env()

    if args.no_verify:
        config.verification_required = False

    # Create orchestrator
    orchestrator = VitanaOrchestrator(config=config)

    # Register adapter based on selection
    adapter_map = {
        "claude": ClaudeAdapter,
        "crewai": CrewAIAdapter,
        "mock": MockAdapter,
    }

    adapter_class = adapter_map.get(args.adapter, ClaudeAdapter)
    adapter = adapter_class()

    # Register for all domains
    for domain in ["frontend", "backend", "memory", "default"]:
        orchestrator.register_adapter(domain, adapter)

    # Initialize adapter
    await adapter.initialize()

    # Parse domain
    domain = None
    if args.domain:
        domain = TaskDomain(args.domain)

    # Create task config
    task_config = TaskConfig(
        vtid=args.vtid,
        title=args.title,
        description=args.description or "",
        domain=domain,
        target_paths=args.targets or [],
        max_retries=args.max_retries,
        require_verification=not args.no_verify,
    )

    # Set up event handlers for output
    def on_task_started(event: str, task, **kwargs):
        formatter.task_started(task)

    def on_task_progress(event: str, task, **kwargs):
        formatter.task_progress(task, event.replace("task.", "").replace("_", " ").title())

    def on_task_completed(event: str, task, **kwargs):
        formatter.task_completed(task)

    def on_task_failed(event: str, task, error: str = "", **kwargs):
        formatter.task_failed(task, error)

    def on_verification(event: str, task, **kwargs):
        passed = "failed" not in event
        formatter.verification_result(task, passed, task.verification_details)

    orchestrator.on("task.started", on_task_started)
    orchestrator.on("task.routing", on_task_progress)
    orchestrator.on("task.dispatched", on_task_progress)
    orchestrator.on("task.verifying", on_task_progress)
    orchestrator.on("task.completed", on_task_completed)
    orchestrator.on("task.failed", on_task_failed)
    orchestrator.on("task.verification_failed", on_verification)

    try:
        # Submit and execute task
        task = await orchestrator.submit_task(task_config)
        result = await orchestrator.execute_task(task.task_id)

        # Show summary
        metrics = get_metrics()
        formatter.summary(metrics.get_summary())

        return 0 if result.status.value == "completed" else 1

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    finally:
        await adapter.shutdown()


def show_status(args: argparse.Namespace, formatter: ConsoleFormatter) -> int:
    """Show orchestrator status"""
    metrics = get_metrics()

    if args.task_id:
        task_metrics = metrics.get_task_metrics(args.task_id)
        if task_metrics:
            print(f"Task: {task_metrics['task_id']}")
            print(f"VTID: {task_metrics['vtid']}")
            print(f"Status: {task_metrics['status']}")
            print(f"Domain: {task_metrics['domain']}")
            print(f"Duration: {task_metrics['duration_ms']}ms")
            print(f"Retries: {task_metrics['retry_count']}")
            print(f"Verified: {task_metrics['verification_passed']}")
        else:
            print(f"Task not found: {args.task_id}")
            return 1
    else:
        formatter.summary(metrics.get_summary())

    return 0


def show_config(args: argparse.Namespace) -> int:
    """Show or initialize configuration"""
    if args.init:
        config_path = Path("vitana-orchestrator.yml")
        if config_path.exists():
            print(f"Config already exists: {config_path}")
            return 1

        default_config = """# Vitana Orchestrator Configuration
# VTID: VTID-01175

vtid: VTID-01175
name: vitana-orchestrator
version: 1.0.0

# Execution settings
max_concurrent_tasks: 5
default_task_timeout_ms: 1800000  # 30 minutes

# Verification settings
verification_required: true
max_verification_attempts: 3
auto_retry_on_verification_failure: true

# Retry settings
max_retries: 3
retry_delay_ms: 10000  # 10 seconds
retry_backoff_multiplier: 2.0

# Safety limits
max_files_per_task: 20
max_directories_per_task: 10

# Provider settings
primary_provider: claude
fallback_provider: gemini
model_preference: claude-3-5-sonnet-20241022

# Feature flags
enable_preflight_checks: true
enable_postflight_validation: true
enable_oasis_events: true
enable_memory_integration: true
enable_metrics: true
enable_checkpointing: true
"""
        config_path.write_text(default_config)
        print(f"Created config: {config_path}")
        return 0

    if args.show:
        config = OrchestratorConfig.from_env()
        import json
        print(json.dumps({
            "vtid": config.vtid,
            "name": config.name,
            "version": config.version,
            "max_concurrent_tasks": config.max_concurrent_tasks,
            "verification_required": config.verification_required,
            "max_retries": config.max_retries,
            "primary_provider": config.primary_provider,
        }, indent=2))
        return 0

    return 0


def main() -> int:
    """Main entry point"""
    args = parse_args()

    # Set up logging
    log_level = "DEBUG" if args.verbose >= 2 else ("INFO" if args.verbose >= 1 else "WARNING")
    if args.quiet:
        log_level = "ERROR"

    setup_logging(
        level=log_level,
        log_file=args.log_file,
        use_colors=not args.no_color,
    )

    # Set up formatter
    output_level = OutputLevel.DEBUG if args.verbose >= 2 else (
        OutputLevel.VERBOSE if args.verbose >= 1 else (
            OutputLevel.QUIET if args.quiet else OutputLevel.NORMAL
        )
    )
    formatter = ConsoleFormatter(level=output_level, use_colors=not args.no_color)

    # Print banner unless quiet
    if not args.quiet and args.command == "run":
        print_banner()

    # Execute command
    if args.command == "run":
        return asyncio.run(run_task(args, formatter))
    elif args.command == "status":
        return show_status(args, formatter)
    elif args.command == "config":
        return show_config(args)
    else:
        print("Use --help for usage information")
        return 1


if __name__ == "__main__":
    sys.exit(main())
