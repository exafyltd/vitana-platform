"""Unit tests for scripts/aws/aurora-privilege-parity.py (VTID-05023, part 0).

Fixture catalogs only, no network, no database, no boto3:
    python3 -m unittest discover -s scripts/aws/test -p 'test_*.py'
"""
import contextlib
import copy
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "fixtures")
SCRIPT = os.path.join(HERE, "..", "aurora-privilege-parity.py")

_spec = importlib.util.spec_from_file_location("aurora_privilege_parity", SCRIPT)
app = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(app)


def fixture(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as fh:
        return json.load(fh)


def rows_for(snap, key, **match):
    return [r for r in snap[key] if all(r.get(k) == v for k, v in match.items())]


def statements(result, **kw):
    return [s for s in app.fix_statements(result, **kw) if not s.startswith("--")]


class ParityTestBase(unittest.TestCase):
    def setUp(self):
        self.sup = fixture("supabase-snapshot.json")
        self.tmp = tempfile.mkdtemp(prefix="parity-test-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, name, doc):
        path = os.path.join(self.tmp, name)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(doc, fh)
        return path

    def run_main(self, sup, aur, *extra):
        argv = ["--supabase-snapshot", self.write("sup.json", sup),
                "--aurora-snapshot", self.write("aur.json", aur), *extra]
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = app.main(argv)
        return code, out.getvalue(), err.getvalue()


class IdenticalCatalogs(ParityTestBase):
    def test_identical_catalogs_pass_and_need_no_fix(self):
        aur = copy.deepcopy(self.sup)
        report = os.path.join(self.tmp, "report.json")
        out_sql = os.path.join(self.tmp, "fix.sql")
        code, out, _ = self.run_main(self.sup, aur, "--check", "--strict", "--report", report,
                                     "--fix", "--out", out_sql)
        self.assertEqual(code, 0, out)
        self.assertIn("RESULT: PASS", out)
        with open(report) as fh:
            data = json.load(fh)
        self.assertTrue(data["ok"])
        self.assertEqual(data["failures"], [])
        with open(out_sql) as fh:
            body = [ln for ln in fh.read().splitlines() if ln and not ln.startswith("--")]
        self.assertEqual(body, [])

    def test_wrapped_and_chunked_snapshot_forms_load(self):
        text = json.dumps(self.sup)
        wrapped = app.normalize_snapshot([{"snapshot": text}], "x")
        self.assertEqual(wrapped, self.sup)
        md5 = __import__("hashlib").md5(text.encode()).hexdigest()
        chunks = [{"i": i, "md5": md5, "chunk": text[i * 100:(i + 1) * 100]}
                  for i in range((len(text) + 99) // 100)]
        self.assertEqual(app.normalize_snapshot(list(reversed(chunks)), "x"), self.sup)
        chunks[1]["chunk"] = chunks[1]["chunk"][::-1]
        with self.assertRaises(app.SnapshotError):
            app.normalize_snapshot(chunks, "x")

    def test_snapshot_missing_required_key_is_an_input_error(self):
        bad = copy.deepcopy(self.sup)
        del bad["rls"]
        code, _, err = self.run_main(bad, self.sup, "--check")
        self.assertEqual(code, 2)
        self.assertIn("rls", err)


class LockedDownFunction(ParityTestBase):
    """Supabase revoked EXECUTE on increment_wallet_balance from PUBLIC/anon/
    authenticated; Aurora still carries the PostgreSQL default + GRANT ALL."""

    def setUp(self):
        super().setUp()
        self.aur = copy.deepcopy(self.sup)
        for grantee in ("PUBLIC", "anon", "authenticated"):
            self.aur["routine_grants"].append({
                "schema": "public", "routine_signature": "increment_wallet_balance(uuid, numeric, text)",
                "routine_name": "increment_wallet_balance", "routine_args": "uuid, numeric, text",
                "prokind": "f", "grantee": grantee, "privilege": "EXECUTE", "extension": None})

    def test_flagged_extra(self):
        result = app.diff(self.sup, self.aur)
        extra = {(r["routine_name"], r["grantee"]) for r in result["routine_grants"]["extra"]}
        self.assertEqual(extra, {("increment_wallet_balance", g) for g in ("PUBLIC", "anon", "authenticated")})
        self.assertEqual(result["routine_grants"]["missing"], [])
        failures, _ = app.gate(result)
        self.assertTrue(any("routine grants EXTRA" in f for f in failures))

    def test_fixed_by_revoke(self):
        sql = statements(app.diff(self.sup, self.aur))
        self.assertIn("REVOKE EXECUTE ON ROUTINE public.increment_wallet_balance(uuid, numeric, text) FROM anon;", sql)
        self.assertIn("REVOKE EXECUTE ON ROUTINE public.increment_wallet_balance(uuid, numeric, text) FROM PUBLIC;", sql)
        self.assertFalse(any(s.startswith("GRANT") for s in sql))

    def test_check_exits_1(self):
        code, out, _ = self.run_main(self.sup, self.aur, "--check")
        self.assertEqual(code, 1)
        self.assertIn("RESULT: FAIL", out)
        self.assertIn("increment_wallet_balance", out)


class RlsParity(ParityTestBase):
    def test_table_without_rls_on_aurora_flagged_and_fixed(self):
        aur = copy.deepcopy(self.sup)
        row = rows_for(aur, "rls", table="wallet_transactions")[0]
        row["rls_enabled"], row["rls_forced"] = False, False
        result = app.diff(self.sup, aur)
        self.assertEqual(len(result["rls"]["mismatch"]), 1)
        self.assertEqual(result["rls"]["mismatch"][0]["table"], "wallet_transactions")
        sql = statements(result)
        self.assertEqual(sql, ["ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;",
                               "ALTER TABLE public.wallet_transactions FORCE ROW LEVEL SECURITY;"])
        code, _, _ = self.run_main(self.sup, aur, "--check")
        self.assertEqual(code, 1)

    def test_aurora_stricter_rls_is_a_mismatch_but_disable_is_only_commented(self):
        sup = copy.deepcopy(self.sup)
        rows_for(sup, "rls", table="profiles")[0]["rls_enabled"] = False
        result = app.diff(sup, self.sup)
        self.assertEqual(len(result["rls"]["mismatch"]), 1)
        all_lines = app.fix_statements(result)
        self.assertEqual(statements(result), [])
        self.assertIn("-- ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;", all_lines)
        self.assertEqual(statements(result, allow_loosen=True),
                         ["ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;"])


class RoleSettings(ParityTestBase):
    def test_statement_timeout_missing_and_different(self):
        aur = copy.deepcopy(self.sup)
        aur["role_settings"] = [
            {"role": "authenticated", "setting": "statement_timeout=30s", "database": None},
            {"role": "authenticated", "setting": "statement_timeout=30s", "database": "vitana"},
        ]
        result = app.diff(self.sup, aur)
        mism = {(m["role"], m["name"]): m for m in result["role_settings"]["mismatch"]}
        self.assertEqual(set(mism), {("anon", "statement_timeout"), ("authenticated", "statement_timeout")})
        self.assertEqual(mism[("anon", "statement_timeout")]["supabase"], "3s")
        sql = statements(result)
        self.assertIn("ALTER ROLE anon SET statement_timeout = '3s';", sql)
        self.assertIn("ALTER ROLE authenticated SET statement_timeout = '8s';", sql)
        # the per-database value would override the role-wide one: reset it first
        self.assertLess(sql.index("ALTER ROLE authenticated IN DATABASE vitana RESET statement_timeout;"),
                        sql.index("ALTER ROLE authenticated SET statement_timeout = '8s';"))
        code, _, _ = self.run_main(self.sup, aur, "--check")
        self.assertEqual(code, 1)

    def test_equal_durations_in_other_units_match(self):
        aur = copy.deepcopy(self.sup)
        aur["role_settings"] = [{"role": "anon", "setting": "statement_timeout=3000", "database": None},
                                {"role": "authenticated", "setting": "statement_timeout=8000ms", "database": "vitana"}]
        self.assertEqual(app.diff(self.sup, aur)["role_settings"]["mismatch"], [])

    def test_extra_setting_on_aurora_reset_only_when_loosening_allowed(self):
        aur = copy.deepcopy(self.sup)
        aur["role_settings"].append({"role": "service_role", "setting": "search_path=public, extensions",
                                     "database": None})
        result = app.diff(self.sup, aur)
        self.assertEqual(len(result["role_settings"]["mismatch"]), 1)
        self.assertEqual(statements(result), [])
        self.assertEqual(statements(result, allow_loosen=True), ["ALTER ROLE service_role RESET search_path;"])


class QuotingAndMixedCase(ParityTestBase):
    def test_quote_ident(self):
        self.assertEqual(app.quote_ident("profiles"), "profiles")
        self.assertEqual(app.quote_ident("VtidLedger"), '"VtidLedger"')
        self.assertEqual(app.quote_ident("user"), '"user"')
        self.assertEqual(app.quote_ident("order"), '"order"')
        self.assertEqual(app.quote_ident("has space"), '"has space"')
        self.assertEqual(app.quote_ident('we"ird'), '"we""ird"')
        self.assertEqual(app.quote_ident("9lives"), '"9lives"')
        self.assertEqual(app.quote_role("PUBLIC"), "PUBLIC")
        self.assertEqual(app.quote_literal("it's"), "'it''s'")
        with self.assertRaises(app.SnapshotError):
            app.quote_ident("x\n; DROP TABLE y")

    def test_mixed_case_table_column_and_function(self):
        aur = copy.deepcopy(self.sup)
        aur["table_grants"].append({"schema": "public", "table": "VtidLedger", "relkind": "r",
                                    "grantee": "anon", "privilege": "INSERT", "extension": None})
        aur["table_grants"].append({"schema": "public", "table": "user", "relkind": "r",
                                    "grantee": "anon", "privilege": "SELECT", "extension": None})
        aur["routine_grants"].append({"schema": "public", "routine_signature": "GetVtid(text)",
                                      "routine_name": "GetVtid", "routine_args": "text", "prokind": "f",
                                      "grantee": "anon", "privilege": "EXECUTE", "extension": None})
        aur["column_grants"].append({"schema": "public", "table": "VtidLedger", "column": "Title",
                                     "grantee": "anon", "privilege": "UPDATE", "extension": None})
        sql = statements(app.diff(self.sup, aur))
        self.assertIn('REVOKE INSERT ON TABLE public."VtidLedger" FROM anon;', sql)
        self.assertIn('REVOKE SELECT ON TABLE public."user" FROM anon;', sql)
        self.assertIn('REVOKE EXECUTE ON ROUTINE public."GetVtid"(text) FROM anon;', sql)
        self.assertIn('REVOKE UPDATE ("Title") ON TABLE public."VtidLedger" FROM anon;', sql)

    def test_signature_only_rows_are_parsed(self):
        row = {"schema": "public", "routine_signature": "GetVtid(text, integer)"}
        self.assertEqual(app.routine_ref(row), 'public."GetVtid"(text, integer)')
        with self.assertRaises(app.SnapshotError):
            app.routine_ref({"schema": "public", "routine_name": "f", "routine_args": "text); DROP TABLE x; --"})

    def test_sequence_uses_on_sequence(self):
        aur = copy.deepcopy(self.sup)
        aur["table_grants"].append({"schema": "public", "table": "profiles_id_seq", "relkind": "S",
                                    "grantee": "anon", "privilege": "UPDATE", "extension": None})
        self.assertEqual(statements(app.diff(self.sup, aur)),
                         ["REVOKE UPDATE ON SEQUENCE public.profiles_id_seq FROM anon;"])

    def test_every_statement_is_one_line(self):
        aur = fixture("aurora-snapshot-drift.json")
        for line in app.fix_statements(app.diff(self.sup, aur)):
            self.assertNotIn("\n", line)
            if not line.startswith("--"):
                self.assertTrue(line.endswith(";"), line)


class MissingAndStrict(ParityTestBase):
    def test_missing_warns_unless_strict_and_fix_grants(self):
        aur = copy.deepcopy(self.sup)
        aur["table_grants"] = [r for r in aur["table_grants"]
                               if not (r["table"] == "profiles" and r["grantee"] == "anon")]
        result = app.diff(self.sup, aur)
        self.assertEqual(len(result["table_grants"]["missing"]), 1)
        self.assertEqual(statements(result), ["GRANT SELECT ON TABLE public.profiles TO anon;"])
        code, out, _ = self.run_main(self.sup, aur, "--check")
        self.assertEqual(code, 0)
        self.assertIn("WARNINGS", out)
        code, _, _ = self.run_main(self.sup, aur, "--check", "--strict")
        self.assertEqual(code, 1)

    def test_table_revoke_restores_supabase_column_grants(self):
        # PostgreSQL: REVOKE UPDATE ON TABLE also removes column-level UPDATE.
        aur = copy.deepcopy(self.sup)
        aur["table_grants"].append({"schema": "public", "table": "profiles", "relkind": "r",
                                    "grantee": "anon", "privilege": "UPDATE", "extension": None})
        sql = statements(app.diff(self.sup, aur))
        revoke = "REVOKE UPDATE ON TABLE public.profiles FROM anon;"
        regrant = 'GRANT UPDATE ("displayName") ON TABLE public.profiles TO anon;'
        self.assertIn(revoke, sql)
        self.assertIn(regrant, sql)
        self.assertLess(sql.index(revoke), sql.index(regrant))


class DefaultPrivilegesMembershipsAttributes(ParityTestBase):
    def test_default_acl_with_role_map(self):
        aur = fixture("aurora-snapshot-drift.json")
        mapped = app.diff(self.sup, aur, role_map={"postgres": "vitana_admin"})["default_acl"]
        self.assertEqual(mapped["extra"], [])
        self.assertEqual(mapped["missing"], [])
        self.assertEqual([r["role"] for r in mapped["owner_role_absent_on_aurora"]], ["supabase_admin"])

    def test_extra_default_acl_fails_and_is_revoked(self):
        aur = copy.deepcopy(self.sup)
        aur["default_acl"].append({"role": "postgres", "schema": "public", "objtype": "f",
                                   "grantee": "anon", "privileges": ["EXECUTE"]})
        result = app.diff(self.sup, aur)
        self.assertEqual(len(result["default_acl"]["extra"]), 1)
        self.assertTrue(app.gate(result)[0])
        self.assertEqual(statements(result),
                         ["ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;"])

    def test_extra_membership_and_bypassrls(self):
        aur = copy.deepcopy(self.sup)
        aur["role_memberships"].append({"role": "service_role", "member_of": "rds_superuser"})
        rows_for(aur, "role_attributes", role="anon")[0]["rolbypassrls"] = True
        result = app.diff(self.sup, aur)
        sql = statements(result)
        self.assertIn("REVOKE rds_superuser FROM service_role;", sql)
        self.assertIn("ALTER ROLE anon NOBYPASSRLS;", sql)
        failures, _ = app.gate(result)
        self.assertTrue(any("membership" in f for f in failures))
        self.assertTrue(any("attribute" in f for f in failures))

    def test_missing_api_role_fails(self):
        aur = copy.deepcopy(self.sup)
        aur["role_attributes"] = [r for r in aur["role_attributes"] if r["role"] != "service_role"]
        self.assertEqual(app.diff(self.sup, aur)["role_attributes"]["missing_roles"], ["service_role"])


class DriftFixture(ParityTestBase):
    """The combined drift fixture: what Aurora looks like after
    setup-aurora-postgrest-grants.sh and a DMS load."""

    def test_full_drift_report_and_fix(self):
        aur = fixture("aurora-snapshot-drift.json")
        out_sql = os.path.join(self.tmp, "fix.sql")
        report = os.path.join(self.tmp, "report.json")
        code, out, _ = self.run_main(self.sup, aur, "--check", "--report", report, "--fix", "--out", out_sql,
                                     "--role-map", "postgres=vitana_admin")
        self.assertEqual(code, 1, out)
        with open(out_sql) as fh:
            sql = [ln for ln in fh.read().splitlines() if ln and not ln.startswith("--")]
        self.assertEqual(sql, [
            'REVOKE INSERT ON TABLE public."VtidLedger" FROM anon;',
            "REVOKE EXECUTE ON ROUTINE public.increment_wallet_balance(uuid, numeric, text) FROM PUBLIC;",
            "REVOKE EXECUTE ON ROUTINE public.increment_wallet_balance(uuid, numeric, text) FROM anon;",
            "REVOKE EXECUTE ON ROUTINE public.increment_wallet_balance(uuid, numeric, text) FROM authenticated;",
            "ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;",
            "ALTER TABLE public.wallet_transactions FORCE ROW LEVEL SECURITY;",
            "ALTER ROLE anon SET statement_timeout = '3s';",
        ])
        with open(report) as fh:
            data = json.load(fh)
        self.assertFalse(data["ok"])
        # extension-owned objects (postgis table, pgvector function) are reported, not gated
        self.assertEqual(data["findings"]["skipped_extension_objects"]["routine_grants"], 1)
        self.assertGreater(data["findings"]["skipped_extension_objects"]["table_grants"], 0)

    def test_extension_objects_gated_on_request(self):
        aur = fixture("aurora-snapshot-drift.json")
        result = app.diff(self.sup, aur, include_extension_objects=True)
        names = {r["routine_name"] for r in result["routine_grants"]["extra"]}
        self.assertIn("vector_dims", names)

    def test_maintain_privilege_is_ignored_not_fixed(self):
        aur = copy.deepcopy(self.sup)
        aur["table_grants"].append({"schema": "public", "table": "profiles", "relkind": "r",
                                    "grantee": "service_role", "privilege": "MAINTAIN", "extension": None})
        result = app.diff(self.sup, aur)
        self.assertEqual(result["table_grants"]["extra"], [])
        self.assertEqual(len(result["ignored_version_specific"]), 1)
        self.assertEqual(statements(result), [])


class SnapshotSql(unittest.TestCase):
    def test_sql_is_one_read_only_select(self):
        body = app.read_snapshot_sql()
        self.assertTrue(body.upper().startswith("WITH"))
        self.assertNotIn(";", body)
        for word in ("INSERT ", "UPDATE ", "DELETE ", "GRANT ", "REVOKE ", "ALTER ", "CREATE ", "DROP ",
                     "TRUNCATE ", "SET ROLE", "COPY "):
            self.assertNotIn(word, body.upper().replace("PRIVILEGE_TYPE", ""), word)
        for key in app.REQUIRED_KEYS + app.OPTIONAL_LIST_KEYS:
            self.assertIn(f"'{key}'", body)

    def test_chunk_wrapper(self):
        sql = app.chunked_sql("SELECT '{}'::text AS snapshot", 0, 19, 1000)
        self.assertIn("generate_series(0, 19)", sql)
        self.assertIn("substr(s.snapshot, i * 1000 + 1, 1000)", sql)
        self.assertIn("md5(s.snapshot)", sql)

    def test_boto3_only_imported_for_the_live_read(self):
        # the diff and these tests must run where boto3 is not installed
        with open(SCRIPT, encoding="utf-8") as fh:
            top_level = [ln for ln in fh if ln.startswith(("import ", "from "))]
        self.assertFalse(any("boto3" in ln for ln in top_level), top_level)


if __name__ == "__main__":
    unittest.main()
