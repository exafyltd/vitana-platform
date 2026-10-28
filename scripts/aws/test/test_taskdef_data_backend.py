"""VTID-05023 part 9: tests for scripts/aws/taskdef-data-backend.py.

No network. Fixtures under fixtures/taskdefs/ are the live task definitions of
2026-10-10 (read-only describe-task-definition), sanitized: secret names and
valueFrom ARNs kept, sensitive-looking env values replaced by "<redacted>",
and the fields the deploy workflows delete before register dropped.

Run: npm run test:aurora-parity   (python3 -m unittest discover -s scripts/aws/test -p 'test_*.py')
"""

import copy
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.normpath(os.path.join(HERE, "..", "taskdef-data-backend.py"))
FIXTURES = os.path.join(HERE, "fixtures", "taskdefs")

_spec = importlib.util.spec_from_file_location("taskdef_data_backend", SCRIPT)
tdb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tdb)

SM = "arn:aws:secretsmanager:eu-central-1:472838866351:secret:"
PROD_PROXY_ARN = SM + "vitana/supabase/prod/url-aurora-proxy-AbC123"
STAGING_PROXY_ARN = SM + "vitana/supabase/staging/url-aurora-proxy-XyZ789"

# fixture file -> (service key, proxy ARN for that environment)
CASES = {
    "gateway.json": ("gateway", PROD_PROXY_ARN),
    "gateway-staging.json": ("gateway-staging", STAGING_PROXY_ARN),
    "verification-engine.json": ("verification-engine", PROD_PROXY_ARN),
    "orb-agent.json": ("orb-agent", PROD_PROXY_ARN),
    "oasis-projector.json": ("oasis-projector", PROD_PROXY_ARN),
    "autopilot-executor.json": ("autopilot-executor", PROD_PROXY_ARN),
    "worker-runner.json": ("worker-runner", PROD_PROXY_ARN),
}


def load(name):
    with open(os.path.join(FIXTURES, name), "rb") as fh:
        raw = fh.read()
    return raw, json.loads(raw)


def read_text(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def run_cli(args, stdin_bytes, env=None):
    return subprocess.run([sys.executable, SCRIPT, *args], input=stdin_bytes,
                          capture_output=True, env=env)


def secrets_of(td):
    return {(c["name"], s["name"]): s["valueFrom"] for c in td["containerDefinitions"] for s in c.get("secrets") or []}


def env_of(td):
    return {(c["name"], e["name"]): e.get("value") for c in td["containerDefinitions"] for e in c.get("environment") or []}


def without(td, paths):
    """td with the switch-controlled entries removed, for "nothing else changed" checks."""
    t = copy.deepcopy(td)
    for c in t["containerDefinitions"]:
        c["secrets"] = [s for s in c.get("secrets") or [] if s["name"] not in paths]
        c["environment"] = [e for e in c.get("environment") or [] if e["name"] not in paths]
    return t


class FixtureShape(unittest.TestCase):
    def test_every_fixture_is_on_supabase_today(self):
        for name, (service, _) in CASES.items():
            _, td = load(name)
            self.assertEqual(tdb.classify(td, service), "supabase", name)

    def test_fixtures_carry_no_redactable_values(self):
        for name in CASES:
            raw, _ = load(name)
            text = raw.decode()
            for bad in ("eyJ", "postgres://", "postgresql://", "ghp_", "github_pat_"):
                self.assertNotIn(bad, text, f"{name} contains {bad!r}")


class Keep(unittest.TestCase):
    def test_keep_is_byte_for_byte(self):
        for name, (service, _) in CASES.items():
            raw, _ = load(name)
            p = run_cli(["--backend", "keep", "--service", service], raw)
            self.assertEqual(p.returncode, 0, p.stderr.decode())
            self.assertEqual(p.stdout, raw, f"{name}: keep changed the bytes")

    def test_keep_is_byte_for_byte_even_for_compact_or_odd_input(self):
        _, td = load("gateway.json")
        compact = json.dumps(td, separators=(",", ":")).encode()
        for blob in (compact, compact + b"\n", b"not json at all"):
            p = run_cli(["--backend", "keep", "--service", "gateway"], blob)
            self.assertEqual(p.returncode, 0, p.stderr.decode())
            self.assertEqual(p.stdout, blob)

    def test_keep_pure_function_returns_the_same_object(self):
        _, td = load("gateway.json")
        self.assertIs(tdb.apply_backend(td, "keep", "gateway"), td)

    def test_keep_on_an_aurora_task_def_carries_aurora_forward(self):
        raw, td = load("orb-agent.json")
        aur = json.dumps(tdb.apply_backend(td, "aurora", "orb-agent", PROD_PROXY_ARN)).encode()
        p = run_cli(["--backend", "keep", "--service", "orb-agent"], aur)
        self.assertEqual(p.stdout, aur)
        self.assertIn(b"currently on: aurora", p.stderr)

    def test_keep_writes_summary(self):
        raw, _ = load("gateway.json")
        with tempfile.NamedTemporaryFile("r", suffix=".md") as fh:
            p = run_cli(["--backend", "keep", "--service", "gateway", "--summary", fh.name], raw)
            self.assertEqual(p.returncode, 0)
            text = read_text(fh.name)
        self.assertIn("input **keep**, task definition on **supabase**", text)
        self.assertIn("SUPABASE_URL <- vitana/supabase/prod/url-OKnsxz", text)


class Aurora(unittest.TestCase):
    def test_flips_exactly_the_expected_refs(self):
        for name, (service, proxy) in CASES.items():
            _, td = load(name)
            cfg = tdb.SERVICES[service]
            out = tdb.apply_backend(td, "aurora", service, proxy)
            s_in, s_out = secrets_of(td), secrets_of(out)
            e_in, e_out = env_of(td), env_of(out)
            c = cfg["container"]
            self.assertEqual(s_out[(c, "SUPABASE_URL")], proxy, name)
            changed_secrets = {k for k in s_in if s_in[k] != s_out.get(k)}
            expected = {(c, "SUPABASE_URL")}
            if cfg["database_url"]:
                expected.add((c, "DATABASE_URL"))
                self.assertEqual(s_out[(c, "DATABASE_URL")], SM + "vitana/aurora/prod/database-url-URDvEh")
            self.assertEqual(changed_secrets, expected, name)
            self.assertEqual(set(s_in), set(s_out), f"{name}: secret names changed")
            changed_env = {k for k in set(e_in) | set(e_out) if e_in.get(k) != e_out.get(k)}
            if cfg["public_url"]:
                self.assertEqual(changed_env, {(c, "SUPABASE_PUBLIC_URL")}, name)
                self.assertEqual(e_out[(c, "SUPABASE_PUBLIC_URL")], "https://inmkhvwdcuyhnxkgfvsb.supabase.co")
            else:
                self.assertEqual(changed_env, set(), name)
            # Everything outside the switched entries is identical, in order.
            ctrl = {"SUPABASE_URL", "DATABASE_URL", "SUPABASE_PUBLIC_URL"}
            self.assertEqual(json.dumps(without(td, ctrl)), json.dumps(without(out, ctrl)), name)
            # Secret positions preserved.
            self.assertEqual([s["name"] for s in td["containerDefinitions"][0]["secrets"]],
                             [s["name"] for s in out["containerDefinitions"][0]["secrets"]])

    def test_input_not_mutated(self):
        raw, td = load("gateway.json")
        tdb.apply_backend(td, "aurora", "gateway", PROD_PROXY_ARN)
        self.assertEqual(json.loads(raw), td)

    def test_gateway_aurora_is_idempotent(self):
        _, td = load("gateway.json")
        once = tdb.apply_backend(td, "aurora", "gateway", PROD_PROXY_ARN)
        twice = tdb.apply_backend(once, "aurora", "gateway", PROD_PROXY_ARN)
        self.assertEqual(once, twice)
        pub = [e for e in twice["containerDefinitions"][0]["environment"] if e["name"] == "SUPABASE_PUBLIC_URL"]
        self.assertEqual(len(pub), 1)

    def test_refuses_a_staging_proxy_arn_on_prod_and_vice_versa(self):
        _, gw = load("gateway.json")
        with self.assertRaises(tdb.Refused):
            tdb.apply_backend(gw, "aurora", "gateway", STAGING_PROXY_ARN)
        _, st = load("gateway-staging.json")
        with self.assertRaises(tdb.Refused):
            tdb.apply_backend(st, "aurora", "gateway-staging", PROD_PROXY_ARN)

    def test_refuses_missing_or_malformed_proxy_arn(self):
        _, td = load("orb-agent.json")
        for bad in (None, "", SM + "vitana/supabase/prod/url-OKnsxz", SM + "vitana/supabase/prod/url-aurora-proxy",
                    "arn:aws:secretsmanager:us-east-1:472838866351:secret:vitana/supabase/prod/url-aurora-proxy-AbC123"):
            with self.assertRaises(tdb.Refused, msg=bad):
                tdb.apply_backend(td, "aurora", "orb-agent", bad)

    def test_prod_switch_refused_on_the_staging_task_def(self):
        _, st = load("gateway-staging.json")
        with self.assertRaises(tdb.Refused) as cm:
            tdb.apply_backend(st, "aurora", "gateway", PROD_PROXY_ARN)
        self.assertIn("family", str(cm.exception))

    def test_cli_aurora_without_arn_or_resolve_refused(self):
        raw, _ = load("orb-agent.json")
        p = run_cli(["--backend", "aurora", "--service", "orb-agent"], raw)
        self.assertEqual(p.returncode, 2)
        self.assertEqual(p.stdout, b"")

    def test_cli_aurora_with_arn(self):
        raw, td = load("oasis-projector.json")
        with tempfile.NamedTemporaryFile("r", suffix=".md") as fh:
            p = run_cli(["--backend", "aurora", "--service", "oasis-projector",
                         "--arn", f"SUPABASE_URL={PROD_PROXY_ARN}", "--summary", fh.name], raw)
            summary = read_text(fh.name)
        self.assertEqual(p.returncode, 0, p.stderr.decode())
        self.assertEqual(json.loads(p.stdout), tdb.apply_backend(td, "aurora", "oasis-projector", PROD_PROXY_ARN))
        self.assertIn("switched from supabase to aurora", p.stderr.decode())
        self.assertIn("DATABASE_URL <- vitana/aurora/prod/database-url-URDvEh", summary)


class Supabase(unittest.TestCase):
    def test_round_trip_is_exact(self):
        for name, (service, proxy) in CASES.items():
            raw, td = load(name)
            aur = tdb.apply_backend(td, "aurora", service, proxy)
            back = tdb.apply_backend(aur, "supabase", service)
            self.assertEqual(json.dumps(back), json.dumps(td), f"{name}: aurora -> supabase is not the original")

    def test_round_trip_via_cli(self):
        for name, (service, proxy) in CASES.items():
            raw, td = load(name)
            a = run_cli(["--backend", "aurora", "--service", service, "--arn", f"SUPABASE_URL={proxy}"], raw)
            self.assertEqual(a.returncode, 0, a.stderr.decode())
            b = run_cli(["--backend", "supabase", "--service", service], a.stdout)
            self.assertEqual(b.returncode, 0, b.stderr.decode())
            self.assertEqual(json.loads(b.stdout), td, name)

    def test_supabase_on_supabase_is_a_no_op(self):
        for name, (service, _) in CASES.items():
            _, td = load(name)
            self.assertEqual(json.dumps(tdb.apply_backend(td, "supabase", service)), json.dumps(td), name)

    def test_supabase_drops_a_public_url_that_was_set(self):
        _, td = load("gateway.json")
        t = copy.deepcopy(td)
        t["containerDefinitions"][0]["environment"].append(
            {"name": "SUPABASE_PUBLIC_URL", "value": "https://inmkhvwdcuyhnxkgfvsb.supabase.co"})
        out = tdb.apply_backend(t, "supabase", "gateway")
        self.assertNotIn("SUPABASE_PUBLIC_URL", [e["name"] for e in out["containerDefinitions"][0]["environment"]])


class Refusals(unittest.TestCase):
    def test_unknown_service_refused_in_every_mode(self):
        raw, _ = load("gateway.json")
        for backend in ("keep", "supabase", "aurora"):
            p = run_cli(["--backend", backend, "--service", "community-app", "--arn",
                         f"SUPABASE_URL={PROD_PROXY_ARN}"], raw)
            self.assertEqual(p.returncode, 2, backend)
            self.assertEqual(p.stdout, b"", backend)
            self.assertIn(b"unknown service", p.stderr)

    def test_unknown_backend_refused(self):
        raw, _ = load("gateway.json")
        p = run_cli(["--backend", "postgres", "--service", "gateway"], raw)
        self.assertEqual(p.returncode, 2)
        self.assertEqual(p.stdout, b"")

    def test_task_def_without_supabase_url_refused_for_aurora_and_supabase(self):
        _, td = load("orb-agent.json")
        t = copy.deepcopy(td)
        for c in t["containerDefinitions"]:
            c["secrets"] = [s for s in c["secrets"] if s["name"] != "SUPABASE_URL"]
        for backend in ("aurora", "supabase"):
            with self.assertRaises(tdb.Refused, msg=backend):
                tdb.apply_backend(t, backend, "orb-agent", PROD_PROXY_ARN)
            p = run_cli(["--backend", backend, "--service", "orb-agent", "--arn",
                         f"SUPABASE_URL={PROD_PROXY_ARN}"], json.dumps(t).encode())
            self.assertEqual(p.returncode, 2)
            self.assertEqual(p.stdout, b"")

    def test_unrecognised_current_ref_is_not_overwritten(self):
        _, td = load("verification-engine.json")
        t = copy.deepcopy(td)
        for s in t["containerDefinitions"][0]["secrets"]:
            if s["name"] == "SUPABASE_URL":
                s["valueFrom"] = SM + "vitana/supabase/prod/some-other-url-QQQQQQ"
        for backend in ("aurora", "supabase"):
            with self.assertRaises(tdb.Refused):
                tdb.apply_backend(t, backend, "verification-engine", PROD_PROXY_ARN)

    def test_projector_unrecognised_database_url_refused(self):
        _, td = load("oasis-projector.json")
        t = copy.deepcopy(td)
        for s in t["containerDefinitions"][0]["secrets"]:
            if s["name"] == "DATABASE_URL":
                s["valueFrom"] = SM + "vitana/other/database-url-QQQQQQ"
        with self.assertRaises(tdb.Refused):
            tdb.apply_backend(t, "aurora", "oasis-projector", PROD_PROXY_ARN)

    def test_wrong_container_refused(self):
        _, td = load("orb-agent.json")
        t = copy.deepcopy(td)
        t["containerDefinitions"][0]["name"] = "sidecar"
        with self.assertRaises(tdb.Refused):
            tdb.apply_backend(t, "aurora", "orb-agent", PROD_PROXY_ARN)


class Resolve(unittest.TestCase):
    """--resolve with a fake `aws` on PATH (no network)."""

    def _fake_aws(self, d, stdout, stderr, code):
        path = os.path.join(d, "aws")
        with open(path, "w") as fh:
            fh.write("#!/bin/sh\n")
            fh.write(f"printf '%s' '{stdout}'\n")
            fh.write(f"printf '%s' '{stderr}' >&2\n")
            fh.write(f"exit {code}\n")
        os.chmod(path, 0o755)

    def _run(self, stdout, stderr, code, var=""):
        raw, _ = load("orb-agent.json")
        with tempfile.TemporaryDirectory() as d:
            self._fake_aws(d, stdout, stderr, code)
            env = dict(os.environ, PATH=d + os.pathsep + os.environ.get("PATH", ""),
                       DATA_BACKEND_AURORA_URL_SECRET_ARN=var)
            return run_cli(["--backend", "aurora", "--service", "orb-agent", "--resolve"], raw, env)

    def test_describe_secret_success(self):
        p = self._run(PROD_PROXY_ARN, "", 0)
        self.assertEqual(p.returncode, 0, p.stderr.decode())
        self.assertIn(PROD_PROXY_ARN, p.stdout.decode())

    def test_secret_missing_fails_fast(self):
        p = self._run("", "An error occurred (ResourceNotFoundException) when calling the DescribeSecret", 254)
        self.assertEqual(p.returncode, 2)
        self.assertIn(b"does not exist", p.stderr)
        self.assertEqual(p.stdout, b"")

    def test_secret_missing_wins_over_the_variable(self):
        p = self._run("", "An error occurred (ResourceNotFoundException)", 254, PROD_PROXY_ARN)
        self.assertEqual(p.returncode, 2)

    def test_access_denied_without_variable_fails(self):
        p = self._run("", "An error occurred (AccessDeniedException) ... is not authorized to perform", 254)
        self.assertEqual(p.returncode, 2)
        self.assertIn(b"SUPABASE_URL_AURORA_PROXY_PROD_ARN", p.stderr)

    def test_access_denied_with_variable_uses_it(self):
        p = self._run("", "An error occurred (AccessDeniedException)", 254, PROD_PROXY_ARN)
        self.assertEqual(p.returncode, 0, p.stderr.decode())
        self.assertIn(PROD_PROXY_ARN, p.stdout.decode())

    def test_access_denied_with_wrong_variable_refused(self):
        p = self._run("", "An error occurred (AccessDeniedException)", 254, SM + "vitana/supabase/prod/url-OKnsxz")
        self.assertEqual(p.returncode, 2)


if __name__ == "__main__":
    unittest.main()
