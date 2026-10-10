#!/usr/bin/env python3
"""taskdef-data-backend.py - the one place the VTID-05023 data_backend switch
rewrites an ECS task definition (cutover plan part 9, option B).

Usage (stdin -> stdout, the task definition JSON the deploy workflow is about
to register):

    python3 scripts/aws/taskdef-data-backend.py --backend keep|supabase|aurora \
        --service <service> [--resolve] [--arn KEY=ARN ...] [--summary FILE] \
        < in.json > out.json

Backends
  keep      The input bytes are written back unchanged (byte for byte). This is
            the default of every workflow input, so a routine deploy - and the
            Command Hub PUBLISH button, which never passes data_backend - carries
            the live task definition's current backend forward.
  aurora    SUPABASE_URL's valueFrom -> the url-aurora-proxy secret (its value is
            the INTERNAL PostgREST-Aurora proxy URL, e.g.
            http://postgrest-aurora-prod.vitana.internal:8080, which serves
            /rest/v1 from Aurora and passes /auth, /storage, /functions and
            /realtime through to Supabase). Gateways also get the environment
            variable SUPABASE_PUBLIC_URL=https://inmkhvwdcuyhnxkgfvsb.supabase.co
            (owner decision R1(b), services/gateway/src/lib/supabase-public-url.ts).
            oasis-projector also gets DATABASE_URL -> vitana/aurora/prod/database-url.
  supabase  The original references, exactly as they were on the live task
            definitions read on 2026-10-10, and SUPABASE_PUBLIC_URL removed (the
            code default is SUPABASE_URL, which is then supabase.co again). An
            aurora output passed through supabase is the original task
            definition again (tested).

Nothing else in the task definition is touched. Every reference is changed in
place (same position in the secrets list), so a round trip is exact.

Secret resolution (--resolve, used by the workflows; tests pass --arn instead)
  * supabase refs and the Aurora database URL are pinned literals below: they
    exist today, and the prod deploy role has no secretsmanager:Describe*
    (VTID-03880), so a rollback to supabase never depends on that permission.
  * the url-aurora-proxy secret is created in the cutover window, so its ARN
    suffix is not known in advance. It is resolved with
    `aws secretsmanager describe-secret` (ARN only - the value is never read).
    ResourceNotFoundException fails the deploy before anything is registered.
    AccessDenied (the prod role) falls back to the environment variable
    DATA_BACKEND_AURORA_URL_SECRET_ARN (the workflows map it from the
    repository variable SUPABASE_URL_AURORA_PROXY_PROD_ARN / _STAGING_ARN,
    the full ARN printed when the secret is created). Neither -> fail.

Exit codes: 0 ok, 2 refused (bad input / unknown service / wrong task
definition / unresolvable secret).
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import re
import subprocess
import sys

ACCOUNT = "472838866351"
REGION = "eu-central-1"
SM_PREFIX = f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:"
PUBLIC_SUPABASE_URL = "https://inmkhvwdcuyhnxkgfvsb.supabase.co"

# Pinned from the live task definitions (read-only describe, 2026-10-10).
SUPABASE_URL_PROD_FULL = SM_PREFIX + "vitana/supabase/prod/url-OKnsxz"
SUPABASE_URL_PROD_PARTIAL = SM_PREFIX + "vitana/supabase/prod/url"
SUPABASE_URL_STAGING_FULL = SM_PREFIX + "vitana/supabase/staging/url-I9rciI"
SUPABASE_DATABASE_URL_PROD = SM_PREFIX + "vitana/supabase/prod/database-url-s8hAHJ"
AURORA_DATABASE_URL_PROD = SM_PREFIX + "vitana/aurora/prod/database-url-URDvEh"

AURORA_PROXY_SECRET = {
    "prod": "vitana/supabase/prod/url-aurora-proxy",
    "staging": "vitana/supabase/staging/url-aurora-proxy",
}

# service key -> how its task definition is switched.
#   family:      the task-definition family the input must belong to (a prod
#                switch can never be applied to the staging task definition)
#   container:   the container that carries SUPABASE_URL
#   env:         prod | staging (which url-aurora-proxy secret)
#   supabase_url: the exact original SUPABASE_URL valueFrom (some live task
#                definitions use the full ARN, some the partial ARN; both are
#                restored as they were)
#   public_url:  gateways only: SUPABASE_PUBLIC_URL is set for aurora
#   database_url: (supabase ref, aurora ref) when DATABASE_URL also moves
SERVICES = {
    "gateway": {
        "family": "vitana-gateway-awsdr", "container": "gateway", "env": "prod",
        "supabase_url": SUPABASE_URL_PROD_FULL, "public_url": True, "database_url": None,
    },
    "gateway-staging": {
        "family": "vitana-gateway", "container": "gateway", "env": "staging",
        "supabase_url": SUPABASE_URL_STAGING_FULL, "public_url": True, "database_url": None,
    },
    "verification-engine": {
        "family": "vitana-vitana-verification-engine", "container": "vitana-verification-engine",
        "env": "prod", "supabase_url": SUPABASE_URL_PROD_PARTIAL, "public_url": False, "database_url": None,
    },
    "orb-agent": {
        "family": "vitana-orb-agent", "container": "orb-agent", "env": "prod",
        "supabase_url": SUPABASE_URL_PROD_PARTIAL, "public_url": False, "database_url": None,
    },
    "autopilot-executor": {
        "family": "vitana-autopilot-executor", "container": "autopilot-executor", "env": "prod",
        "supabase_url": SUPABASE_URL_PROD_FULL, "public_url": False, "database_url": None,
    },
    "oasis-projector": {
        "family": "vitana-oasis-projector", "container": "oasis-projector", "env": "prod",
        "supabase_url": SUPABASE_URL_PROD_PARTIAL, "public_url": False,
        "database_url": (SUPABASE_DATABASE_URL_PROD, AURORA_DATABASE_URL_PROD),
    },
    # No deploy workflow (retired, VTID-04327; service at desired=0). Kept so the
    # switch is ready if the service is ever revived with a workflow.
    "worker-runner": {
        "family": "vitana-worker-runner", "container": "worker-runner", "env": "prod",
        "supabase_url": SUPABASE_URL_PROD_PARTIAL, "public_url": False, "database_url": None,
    },
}

BACKENDS = ("keep", "supabase", "aurora")


class Refused(Exception):
    pass


def aurora_proxy_arn_pattern(env: str) -> re.Pattern:
    return re.compile("^" + re.escape(SM_PREFIX + AURORA_PROXY_SECRET[env]) + r"-[A-Za-z0-9]{6}$")


def _container(td: dict, cfg: dict) -> dict:
    with_url = [c for c in td.get("containerDefinitions", [])
                if any(s.get("name") == "SUPABASE_URL" for s in (c.get("secrets") or []))]
    if len(with_url) != 1:
        raise Refused(f"expected exactly one container with a SUPABASE_URL secret, found {len(with_url)}")
    c = with_url[0]
    if c.get("name") != cfg["container"]:
        raise Refused(f"SUPABASE_URL is on container '{c.get('name')}', expected '{cfg['container']}'")
    return c


def _secret(c: dict, name: str) -> dict:
    hits = [s for s in (c.get("secrets") or []) if s.get("name") == name]
    if len(hits) != 1:
        raise Refused(f"container '{c.get('name')}' has {len(hits)} '{name}' secrets, expected 1")
    return hits[0]


def classify(td: dict, service: str) -> str:
    """supabase | aurora | unknown - which backend the task definition points at."""
    cfg = SERVICES[service]
    c = _container(td, cfg)
    ref = _secret(c, "SUPABASE_URL").get("valueFrom", "")
    if ref == cfg["supabase_url"]:
        return "supabase"
    if aurora_proxy_arn_pattern(cfg["env"]).match(ref):
        return "aurora"
    return "unknown"


def apply_backend(td: dict, backend: str, service: str, aurora_url_arn: str | None = None) -> dict:
    """Pure function: return a NEW task definition switched to `backend`."""
    if backend not in BACKENDS:
        raise Refused(f"unknown backend '{backend}' (keep|supabase|aurora)")
    if service not in SERVICES:
        raise Refused(f"unknown service '{service}' (known: {', '.join(sorted(SERVICES))})")
    cfg = SERVICES[service]
    if backend == "keep":
        return td
    if td.get("family") != cfg["family"]:
        raise Refused(f"task definition family '{td.get('family')}' is not '{cfg['family']}' "
                      f"(service '{service}') - refusing to switch the wrong task definition")
    out = copy.deepcopy(td)
    c = _container(out, cfg)
    url = _secret(c, "SUPABASE_URL")
    current = classify(td, service)
    if current == "unknown":
        raise Refused(f"SUPABASE_URL valueFrom '{url.get('valueFrom')}' is neither the original Supabase "
                      f"reference nor a {AURORA_PROXY_SECRET[cfg['env']]} ARN - refusing to overwrite it")
    if backend == "aurora":
        if not aurora_url_arn or not aurora_proxy_arn_pattern(cfg["env"]).match(aurora_url_arn):
            raise Refused(f"aurora needs the full ARN of {AURORA_PROXY_SECRET[cfg['env']]} "
                          f"({SM_PREFIX}{AURORA_PROXY_SECRET[cfg['env']]}-XXXXXX), got '{aurora_url_arn or ''}'")
        url["valueFrom"] = aurora_url_arn
    else:
        url["valueFrom"] = cfg["supabase_url"]

    if cfg["database_url"]:
        supa_db, aurora_db = cfg["database_url"]
        db = _secret(c, "DATABASE_URL")
        if db.get("valueFrom") not in (supa_db, aurora_db):
            raise Refused(f"DATABASE_URL valueFrom '{db.get('valueFrom')}' is neither {supa_db} nor {aurora_db}")
        db["valueFrom"] = aurora_db if backend == "aurora" else supa_db

    if cfg["public_url"]:
        env = c.get("environment")
        if env is None:
            env = c["environment"] = []
        idx = [i for i, e in enumerate(env) if e.get("name") == "SUPABASE_PUBLIC_URL"]
        if backend == "aurora":
            if idx:
                for i in idx[1:]:
                    env[i] = None
                env[idx[0]] = {"name": "SUPABASE_PUBLIC_URL", "value": PUBLIC_SUPABASE_URL}
                c["environment"] = [e for e in env if e is not None]
            else:
                env.append({"name": "SUPABASE_PUBLIC_URL", "value": PUBLIC_SUPABASE_URL})
        else:
            c["environment"] = [e for e in env if e.get("name") != "SUPABASE_PUBLIC_URL"]
    return out


def describe_lines(td: dict, service: str) -> list[str]:
    """Secret NAMES and env values that the switch controls (no secret values)."""
    cfg = SERVICES[service]
    c = _container(td, cfg)

    def short(ref: str) -> str:
        return ref[len(SM_PREFIX):] if ref.startswith(SM_PREFIX) else ref

    lines = [f"SUPABASE_URL <- {short(_secret(c, 'SUPABASE_URL').get('valueFrom', ''))}"]
    if cfg["database_url"]:
        lines.append(f"DATABASE_URL <- {short(_secret(c, 'DATABASE_URL').get('valueFrom', ''))}")
    if cfg["public_url"]:
        pub = [e.get("value") for e in (c.get("environment") or []) if e.get("name") == "SUPABASE_PUBLIC_URL"]
        lines.append(f"SUPABASE_PUBLIC_URL = {pub[0] if pub else '(unset - code default: SUPABASE_URL)'}")
    return lines


def resolve_aurora_url_arn(service: str) -> str:
    """describe-secret (ARN only); AccessDenied -> DATA_BACKEND_AURORA_URL_SECRET_ARN."""
    cfg = SERVICES[service]
    name = AURORA_PROXY_SECRET[cfg["env"]]
    pattern = aurora_proxy_arn_pattern(cfg["env"])
    proc = subprocess.run(
        ["aws", "secretsmanager", "describe-secret", "--secret-id", name,
         "--region", REGION, "--query", "ARN", "--output", "text"],
        capture_output=True, text=True)
    arn = (proc.stdout or "").strip()
    if proc.returncode == 0 and pattern.match(arn):
        print(f"resolved {name} via describe-secret", file=sys.stderr)
        return arn
    err = (proc.stderr or "").strip()
    if "ResourceNotFoundException" in err:
        raise Refused(f"secret {name} does not exist - create it first (cutover window step: its value is the "
                      f"internal proxy URL). Nothing was registered.")
    fallback = os.environ.get("DATA_BACKEND_AURORA_URL_SECRET_ARN", "").strip()
    if re.search(r"AccessDenied|not authorized", err):
        if not fallback:
            raise Refused(f"this deploy role may not DescribeSecret {name} (VTID-03880) and the repository "
                          f"variable with its full ARN is unset - set SUPABASE_URL_AURORA_PROXY_"
                          f"{cfg['env'].upper()}_ARN to the ARN printed when the secret was created")
        if not pattern.match(fallback):
            raise Refused(f"repository variable ARN '{fallback}' is not a {name} ARN")
        print(f"::warning::describe-secret {name} denied for this role; using the repository variable ARN "
              f"(existence not verified here - a missing secret stops the new tasks and the deploy rolls back)",
              file=sys.stderr)
        return fallback
    raise Refused(f"describe-secret {name} failed: {err[:300]}")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--backend", required=True)
    ap.add_argument("--service", required=True)
    ap.add_argument("--resolve", action="store_true", help="resolve the url-aurora-proxy ARN (aurora only)")
    ap.add_argument("--arn", action="append", default=[], metavar="SUPABASE_URL=ARN",
                    help="explicit url-aurora-proxy ARN (tests / dry runs)")
    ap.add_argument("--summary", help="append a markdown summary to this file (e.g. $GITHUB_STEP_SUMMARY)")
    args = ap.parse_args(argv)

    raw = sys.stdin.buffer.read()
    backend = (args.backend or "keep").strip()
    try:
        if backend not in BACKENDS:
            raise Refused(f"unknown backend '{backend}' (keep|supabase|aurora)")
        if args.service not in SERVICES:
            raise Refused(f"unknown service '{args.service}' (known: {', '.join(sorted(SERVICES))})")
    except Refused as e:
        print(f"::error::data_backend: {e}", file=sys.stderr)
        return 2

    if backend == "keep":
        # Byte-for-byte passthrough FIRST. What follows only describes the
        # current state and can never fail or alter a keep deploy.
        sys.stdout.buffer.write(raw)
        sys.stdout.buffer.flush()
        try:
            td = json.loads(raw)
            state, detail = classify(td, args.service), describe_lines(td, args.service)
        except Exception as e:  # noqa: BLE001 - informational only
            state, detail = f"unknown ({e})", []
        _report(args.summary, args.service, backend,
                f"data_backend=keep - task definition unchanged (currently on: {state})", state, detail)
        return 0

    try:
        td = json.loads(raw)
        before = classify(td, args.service)
        arns = dict(a.split("=", 1) for a in args.arn if "=" in a)
        aurora_arn = arns.get("SUPABASE_URL")
        if backend == "aurora" and not aurora_arn:
            if not args.resolve:
                raise Refused("aurora needs --resolve or --arn SUPABASE_URL=<url-aurora-proxy ARN>")
            aurora_arn = resolve_aurora_url_arn(args.service)
        out_td = apply_backend(td, backend, args.service, aurora_arn)
        after = classify(out_td, args.service)
    except Refused as e:
        print(f"::error::data_backend: {e}", file=sys.stderr)
        return 2
    except (ValueError, KeyError, TypeError, AttributeError) as e:
        print(f"::error::data_backend: unreadable task definition: {e}", file=sys.stderr)
        return 2
    sys.stdout.write(json.dumps(out_td))
    sys.stdout.flush()
    _report(args.summary, args.service, backend,
            f"data_backend={backend} - switched from {before} to {after}", after,
            describe_lines(out_td, args.service))
    return 0


def _report(summary: str | None, service: str, backend: str, head: str, state: str, detail: list[str]) -> None:
    print(head, file=sys.stderr)
    for line in detail:
        print(f"  {line}", file=sys.stderr)
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(f"- Data backend ({service}): input **{backend}**, task definition on **{state}**\n")
            for line in detail:
                fh.write(f"  - `{line}`\n")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
