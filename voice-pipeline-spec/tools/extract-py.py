#!/usr/bin/env python3
"""
Extracts the actual feature surface of services/agents/orb-agent/ via libcst
AST walk. Output: extracted/livekit.json

What it extracts:
  - tools: every function decorated with @function_tool
  - oasis_topics: every literal string passed as `topic=` to oasis.emit(...)
  - watchdogs: module-level UPPER_SNAKE_CASE constants ending in _MS / _THRESHOLD /
    _TIMEOUT / starting with MAX_

Stub today: the orb-agent service does not exist yet. When it ships in a
follow-up PR this script activates automatically — the CI workflow already
invokes it and tolerates the "service not present" no-op exit.

Run: npm run extract:py
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ORB_AGENT_DIR = REPO_ROOT / "services" / "agents" / "orb-agent"
OUT_PATH = Path(__file__).resolve().parents[1] / "extracted" / "livekit.json"


def empty_extract(reason: str) -> dict:
    return {
        "source": "services/agents/orb-agent/",
        "extracted_at": datetime.now(timezone.utc).isoformat(),
        "status": "not_yet_implemented",
        "reason": reason,
        "tools": [],
        "oasis_topics": [],
        "watchdogs": [],
        "system_instruction_signatures": {"authenticated": None, "anonymous": None},
    }


def write_out(data: dict) -> None:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(data, indent=2) + "\n")
    print(
        f"extracted livekit surface: {len(data['tools'])} tools, "
        f"{len(data['oasis_topics'])} topics, {len(data['watchdogs'])} watchdogs "
        f"→ {OUT_PATH}",
        file=sys.stderr,
    )


def main() -> int:
    if not ORB_AGENT_DIR.exists():
        out = empty_extract("services/agents/orb-agent/ does not exist yet")
        write_out(out)
        return 0

    # Lazy import: libcst is only needed once the service ships.
    try:
        import libcst as cst  # type: ignore[import-not-found]
    except ImportError:
        out = empty_extract("libcst not installed; install with `pip install libcst`")
        write_out(out)
        return 0

    tools: list[dict] = []
    oasis_topics: list[dict] = []
    watchdogs: list[dict] = []
    auth_sig: list[str] | None = None
    anon_sig: list[str] | None = None

    for py_path in sorted(ORB_AGENT_DIR.rglob("*.py")):
        try:
            module = cst.parse_module(py_path.read_text())
        except Exception as exc:
            print(f"  parse error in {py_path}: {exc}", file=sys.stderr)
            continue

        # Walk top-level statements for constants
        for stmt in module.body:
            if isinstance(stmt, cst.SimpleStatementLine):
                for small in stmt.body:
                    if isinstance(small, cst.AnnAssign | cst.Assign):  # type: ignore[arg-type]
                        target_name = _const_name(small)
                        if target_name and _is_watchdog_name(target_name):
                            value = _try_eval_int(small.value)
                            if value is not None:
                                watchdogs.append(
                                    {
                                        "name": target_name.lower(),
                                        "value": value,
                                        "line": small.lineno if hasattr(small, "lineno") else 0,
                                        "file": str(py_path.relative_to(REPO_ROOT)),
                                    }
                                )

        # Walk full tree for decorator + emit + signature patterns
        class Visitor(cst.CSTVisitor):
            def visit_FunctionDef(self, node: "cst.FunctionDef") -> None:
                nonlocal auth_sig, anon_sig
                for dec in node.decorators:
                    dec_name = _decorator_name(dec)
                    if dec_name == "function_tool":
                        tools.append(
                            {
                                "name": node.name.value,
                                "line": 0,
                                "file": str(py_path.relative_to(REPO_ROOT)),
                            }
                        )
                if node.name.value == "build_live_system_instruction":
                    auth_sig = [p.name.value for p in node.params.params]
                elif node.name.value == "build_anonymous_system_instruction":
                    anon_sig = [p.name.value for p in node.params.params]

            def visit_Call(self, node: "cst.Call") -> None:
                callee = _call_path(node.func)
                if callee.endswith("oasis.emit") or callee == "emit":
                    for kw in node.args:
                        if (
                            kw.keyword is not None
                            and kw.keyword.value == "topic"
                            and isinstance(kw.value, cst.SimpleString)
                        ):
                            topic = kw.value.evaluated_value
                            if "." in topic:
                                oasis_topics.append(
                                    {
                                        "topic": topic,
                                        "line": 0,
                                        "file": str(py_path.relative_to(REPO_ROOT)),
                                    }
                                )

        module.visit(Visitor())

    out = {
        "source": "services/agents/orb-agent/",
        "extracted_at": datetime.now(timezone.utc).isoformat(),
        "status": "extracted",
        "tools": _dedupe(tools, "name"),
        "oasis_topics": _dedupe(oasis_topics, "topic"),
        "watchdogs": _dedupe(watchdogs, "name"),
        "system_instruction_signatures": {
            "authenticated": auth_sig,
            "anonymous": anon_sig,
        },
    }
    write_out(out)
    return 0


def _const_name(node) -> str | None:
    targets = getattr(node, "targets", None) or [getattr(node, "target", None)]
    for t in targets:
        if t is None:
            continue
        target = getattr(t, "target", t)
        name = getattr(target, "value", None)
        if isinstance(name, str):
            return name
    return None


def _is_watchdog_name(name: str) -> bool:
    if not name.isupper():
        return False
    return (
        name.endswith("_MS")
        or name.endswith("_THRESHOLD")
        or name.endswith("_TIMEOUT")
        or name.startswith("MAX_")
        or name.endswith("_BUCKET")
    )


def _try_eval_int(value) -> int | None:
    import libcst as cst  # type: ignore[import-not-found]

    if isinstance(value, cst.Integer):
        return int(value.value.replace("_", ""))
    if isinstance(value, cst.BinaryOperation) and isinstance(value.operator, cst.Multiply):
        left = _try_eval_int(value.left)
        right = _try_eval_int(value.right)
        if left is not None and right is not None:
            return left * right
    return None


def _decorator_name(dec) -> str:
    expr = dec.decorator
    return _call_path(expr if not hasattr(expr, "func") else expr.func)


def _call_path(node) -> str:
    import libcst as cst  # type: ignore[import-not-found]

    if isinstance(node, cst.Name):
        return node.value
    if isinstance(node, cst.Attribute):
        return _call_path(node.value) + "." + node.attr.value
    return ""


def _dedupe(items: list[dict], key: str) -> list[dict]:
    seen: set = set()
    out: list[dict] = []
    for item in items:
        k = item.get(key)
        if k not in seen:
            seen.add(k)
            out.append(item)
    return out


if __name__ == "__main__":
    sys.exit(main())
