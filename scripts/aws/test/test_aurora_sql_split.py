"""VTID-05023 part 8: tests for scripts/aws/aurora_sql_split.py.

1. Tricky lexing cases (comments, strings, E'' escapes, quoted identifiers,
   dollar quotes with any tag, BEGIN ATOMIC, parentheses) and classification
   (transaction control dropped, ROLLBACK refused, non-transactional flagged,
   psql meta-commands refused with their line).
2. A sweep over every supabase/migrations/*.sql: the splitter never errors
   except on files with psql meta-commands, nothing outside the statements is
   lost (only whitespace, comments and ';' between them) and every statement
   re-splits to itself.
3. On a throwaway local Postgres (initdb/pg_ctl; only with REQUIRE_PG=1, which
   npm run test:aurora-migrations sets, so test:aurora-parity's discover stays
   fast): >= 15 real migration files applied two ways
   — `psql -v ON_ERROR_STOP=1 -1 -f file` vs. the splitter's statements sent
   one at a time (extended protocol, one statement per call, like the Data
   API) inside one transaction — give identical `pg_dump --schema-only`, and
   the splitter's statement count equals the number of statements psql sends
   (counted in the server log, log_statement=all).
Never touches Supabase or Aurora.
"""
from __future__ import annotations

import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts", "aws"))

from aurora_sql_split import SplitError, split_sql  # noqa: E402

MIGRATIONS = sorted(glob.glob(os.path.join(ROOT, "supabase", "migrations", "*.sql")))
SPLITTER = os.path.join(ROOT, "scripts", "aws", "aurora_sql_split.py")


def sqls(text):
    return [s.sql for s in split_sql(text).statements]


class TestLexing(unittest.TestCase):
    def test_line_comments(self):
        self.assertEqual(sqls("SELECT 1; -- it's; fine\nSELECT 2;"), ["SELECT 1", "SELECT 2"])
        self.assertEqual(sqls("-- leading; comment\nSELECT 1 -- trailing;\n;"), ["SELECT 1 -- trailing;"])

    def test_nested_block_comments(self):
        out = sqls("/* a /* b; */ c; ' */ SELECT 1; SELECT /* ; */ 2")
        self.assertEqual(out, ["/* a /* b; */ c; ' */ SELECT 1", "SELECT /* ; */ 2"])

    def test_single_quoted_strings(self):
        self.assertEqual(sqls("SELECT 'a;b''c;'; SELECT 2"), ["SELECT 'a;b''c;'", "SELECT 2"])
        # standard_conforming_strings: a backslash is literal in '...'
        self.assertEqual(sqls(r"SELECT 'a\'; SELECT 2;"), [r"SELECT 'a\'", "SELECT 2"])
        # a typed literal is not an E'' string
        self.assertEqual(sqls(r"SELECT date'a\'; SELECT 2;"), [r"SELECT date'a\'", "SELECT 2"])

    def test_e_strings(self):
        self.assertEqual(sqls(r"SELECT E'it\'s; here'; SELECT 2"), [r"SELECT E'it\'s; here'", "SELECT 2"])
        self.assertEqual(sqls(r"SELECT e'x\\'; SELECT 2"), [r"SELECT e'x\\'", "SELECT 2"])
        self.assertEqual(sqls("SELECT E'a'';b'; SELECT 2"), ["SELECT E'a'';b'", "SELECT 2"])

    def test_double_quoted_identifiers(self):
        self.assertEqual(sqls('CREATE TABLE "we;ird""x" (a int); SELECT 2'),
                         ['CREATE TABLE "we;ird""x" (a int)', "SELECT 2"])

    def test_dollar_quotes_any_tag(self):
        self.assertEqual(sqls("DO $$ BEGIN PERFORM 1; END $$; SELECT 2"),
                         ["DO $$ BEGIN PERFORM 1; END $$", "SELECT 2"])
        body = "CREATE FUNCTION f() RETURNS text LANGUAGE sql AS $fn$ SELECT $$;$$ || ';' $fn$"
        self.assertEqual(sqls(body + "; SELECT 2"), [body, "SELECT 2"])
        body = "DO $body$ BEGIN RAISE NOTICE '$x$;'; END; $body$"
        self.assertEqual(sqls(body + ";SELECT 2"), [body, "SELECT 2"])
        # '$' inside an identifier and $n parameters are not dollar quotes
        self.assertEqual(sqls("SELECT a$b$c FROM t; SELECT 2"), ["SELECT a$b$c FROM t", "SELECT 2"])
        self.assertEqual(sqls("PREPARE p AS SELECT $1; SELECT 2"), ["PREPARE p AS SELECT $1", "SELECT 2"])

    def test_begin_atomic_and_parentheses(self):
        fn = ("CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; "
              "SELECT CASE WHEN true THEN 1 END; END")
        self.assertEqual(sqls(fn + "; SELECT 2;"), [fn, "SELECT 2"])
        rule = "CREATE RULE r AS ON INSERT TO t DO ALSO (INSERT INTO a VALUES (1); INSERT INTO b VALUES (2))"
        self.assertEqual(sqls(rule + "; SELECT 2"), [rule, "SELECT 2"])

    def test_semicolon_free_tail_and_empty_statements(self):
        self.assertEqual(sqls(";;SELECT 1;;\n  ;SELECT 2"), ["SELECT 1", "SELECT 2"])
        self.assertEqual(sqls("-- only a comment\n/* and this */\n"), [])

    def test_line_numbers(self):
        r = split_sql("SELECT 'a\nb';\n\n/* x\n*/\nSELECT $$\n\n$$;\nSELECT 3")
        self.assertEqual([s.line for s in r.statements], [1, 4, 9])

    def test_unterminated(self):
        for bad in ("SELECT 'abc", 'SELECT "abc', "SELECT $$ abc", "/* abc", r"SELECT E'abc\'"):
            with self.assertRaises(SplitError, msg=bad):
                split_sql(bad)


class TestClassification(unittest.TestCase):
    def test_transaction_control_dropped(self):
        r = split_sql("BEGIN; CREATE TABLE a(); COMMIT;\nbegin work;\nSTART TRANSACTION ISOLATION LEVEL "
                      "SERIALIZABLE; SELECT 1; END;")
        self.assertEqual([s.sql for s in r.statements], ["CREATE TABLE a()", "SELECT 1"])
        self.assertEqual(len(r.dropped), 5)
        self.assertTrue(all(s.transactional for s in r.statements))

    def test_rollback_is_refused_but_savepoints_kept(self):
        with self.assertRaises(SplitError) as cm:
            split_sql("BEGIN;\nCREATE TABLE a();\nROLLBACK;")
        self.assertEqual(cm.exception.line, 3)
        with self.assertRaises(SplitError):
            split_sql("abort;")
        r = split_sql("SAVEPOINT s; SELECT 1; ROLLBACK TO SAVEPOINT s; RELEASE s")
        self.assertEqual(len(r.statements), 4)
        self.assertTrue(all(s.transactional for s in r.statements))

    def test_non_transactional(self):
        nontx = [
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (a)",
            "create unique index concurrently i on t (a)",
            "DROP INDEX CONCURRENTLY IF EXISTS i",
            "REINDEX TABLE CONCURRENTLY t",
            "REINDEX (VERBOSE) INDEX CONCURRENTLY i",
            "REINDEX DATABASE vitana",
            "VACUUM ANALYZE t",
            "CREATE DATABASE x",
            "DROP DATABASE IF EXISTS x",
            "ALTER SYSTEM SET work_mem = '64MB'",
        ]
        tx = [
            "ALTER TYPE mood ADD VALUE IF NOT EXISTS 'meh'",
            "CREATE INDEX i ON t (a)",
            "REFRESH MATERIALIZED VIEW CONCURRENTLY mv",
            "REINDEX TABLE t",
            "SELECT 'CREATE INDEX CONCURRENTLY'",
            "DO $$ BEGIN EXECUTE 'VACUUM'; END $$",
        ]
        r = split_sql(";\n".join(nontx + tx))
        flags = [s.transactional for s in r.statements]
        self.assertEqual(flags, [False] * len(nontx) + [True] * len(tx))
        self.assertEqual(len(r.non_transactional), len(nontx))

    def test_meta_command_hard_error_names_line(self):
        with self.assertRaises(SplitError) as cm:
            split_sql("SELECT 1;\n\\set ON_ERROR_STOP on\nSELECT 2;")
        self.assertEqual(cm.exception.line, 2)
        self.assertIn("\\set ON_ERROR_STOP on", cm.exception.message)
        # backslashes inside strings, dollar quotes and comments are fine
        self.assertEqual(len(split_sql("SELECT '\\n'; SELECT $$\\x$$; -- \\q\n/* \\i x */ SELECT 3").statements), 3)

    def test_cli_json_and_exit_codes(self):
        with tempfile.TemporaryDirectory() as d:
            good = os.path.join(d, "good.sql")
            with open(good, "w") as fh:
                fh.write("BEGIN;\nCREATE TABLE a();\nCREATE INDEX CONCURRENTLY i ON a ((1));\nCOMMIT;\n")
            out = subprocess.run([sys.executable, SPLITTER, good], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            import json
            doc = json.loads(out.stdout)
            self.assertEqual(doc["counts"], {"statements": 2, "non_transactional": 1, "dropped": 2})
            self.assertEqual(doc["statements"][1]["line"], 3)
            bad = os.path.join(d, "bad.sql")
            with open(bad, "w") as fh:
                fh.write("SELECT 1;\n\n\\i other.sql\n")
            out = subprocess.run([sys.executable, SPLITTER, bad], capture_output=True, text=True)
            self.assertEqual(out.returncode, 1)
            self.assertIn("bad.sql:3:", out.stderr)


_COMMENT_RE = re.compile(r"--[^\n]*")


def _only_noise(gap: str) -> bool:
    s = _COMMENT_RE.sub("", gap)
    prev = None
    while prev != s:
        prev = s
        s = re.sub(r"/\*(?:(?!/\*|\*/).)*\*/", "", s, flags=re.S)
    return re.fullmatch(r"[\s;]*", s) is not None


class TestMigrationSweep(unittest.TestCase):
    def test_every_migration_file(self):
        self.assertGreater(len(MIGRATIONS), 100)
        meta_files, total = [], 0
        for path in MIGRATIONS:
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
            has_meta = re.search(r"^\s*\\", text, re.M) is not None
            try:
                r = split_sql(text)
            except SplitError as e:
                self.assertTrue(has_meta and "meta-command" in e.message, f"{path}: {e}")
                meta_files.append(path)
                continue
            parts = sorted(r.statements + r.dropped, key=lambda s: s.start)
            cursor = 0
            for st in parts:
                self.assertEqual(text[st.start:st.start + len(st.sql)], st.sql, path)
                self.assertTrue(_only_noise(text[cursor:st.start]),
                                f"{path}: text lost before line {st.line}: {text[cursor:st.start][:200]!r}")
                cursor = st.start + len(st.sql)
                again = split_sql(st.sql)
                self.assertEqual([s.sql for s in again.statements + again.dropped], [st.sql],
                                 f"{path}: statement at line {st.line} re-splits differently")
            self.assertTrue(_only_noise(text[cursor:]), f"{path}: trailing text lost")
            total += len(r.statements)
        self.assertGreater(total, 1000)
        # only the 7 BOOTSTRAP files carrying `\set ON_ERROR_STOP on` today
        self.assertLessEqual(len(meta_files), 7, meta_files)


# ---------------------------------------------------------------- Postgres ---

def _unsafe_host(h: str) -> bool:
    return any(x in (h or "") for x in ("supabase", "amazonaws", "rds"))


class LocalPg:
    """A private throwaway cluster with log_statement=all (auth-bridge.sh pattern)."""

    def __init__(self):
        self.work = tempfile.mkdtemp(prefix="aurora-split-pg-")
        pgbin = os.environ.get("PGBIN") or (sorted(glob.glob("/usr/lib/postgresql/*/bin"),
                                                   key=lambda p: [int(x) for x in re.findall(r"\d+", p)]) or [""])[-1]
        self.pgbin = pgbin
        self.run_as = []
        if os.getuid() == 0:
            shutil.chown(self.work, "postgres")
            self.run_as = ["sudo", "-u", "postgres"]
        self.data = os.path.join(self.work, "data")
        self.log = os.path.join(self.work, "server.log")
        self.port = os.environ.get("PGPORT_TEST_SPLIT", "55441")
        subprocess.run(self.run_as + [f"{pgbin}/initdb", "-D", self.data, "-U", "postgres", "-A", "trust"],
                       check=True, capture_output=True)
        opts = (f"-p {self.port} -k {self.work} -c listen_addresses='' -c log_statement=all "
                f"-c log_line_prefix='@@ ' -c client_min_messages=warning")
        subprocess.run(self.run_as + [f"{pgbin}/pg_ctl", "-D", self.data, "-l", self.log, "-o", opts, "-w", "start"],
                       check=True, capture_output=True)
        self.env = dict(os.environ, PGHOST=self.work, PGPORT=self.port, PGUSER="postgres", PGDATABASE="postgres")

    def stop(self):
        subprocess.run(self.run_as + [f"{self.pgbin}/pg_ctl", "-D", self.data, "-m", "immediate", "stop"],
                       capture_output=True)
        shutil.rmtree(self.work, ignore_errors=True)

    def psql(self, db, *args, input=None):
        return subprocess.run(["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", db, *args],
                              env=self.env, capture_output=True, text=True, input=input)

    def log_size(self):
        return os.path.getsize(self.log)

    def statements_logged_since(self, offset):
        with open(self.log, encoding="utf-8", errors="replace") as fh:
            fh.seek(offset)
            return sum(1 for line in fh if line.startswith("@@ ") and "LOG:  statement: " in line)


PREREQ = r"""
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN CREATE ROLE authenticator NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN CREATE ROLE supabase_admin NOLOGIN; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, phone text,
  raw_user_meta_data jsonb, raw_app_meta_data jsonb, created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(), email_confirmed_at timestamptz, last_sign_in_at timestamptz,
  deleted_at timestamptz);
"""


def _trickiness(text: str) -> int:
    return (3 * len(re.findall(r"\$[A-Za-z_]\w*\$", text)) + text.count("$$") + 2 * text.count("E'")
            + text.count("/*") + text.count("''") + text.count('"'))


_NOISE_DUMP = re.compile(r"^(--|\\restrict|\\unrestrict|SET |SELECT pg_catalog\.set_config)")


def _clean_dump(s: str) -> str:
    return "\n".join(l for l in s.splitlines() if l.strip() and not _NOISE_DUMP.match(l))


@unittest.skipUnless(os.environ.get("REQUIRE_PG") == "1",
                     "Postgres part runs under npm run test:aurora-migrations (REQUIRE_PG=1)")
class TestAgainstPsql(unittest.TestCase):
    pg: LocalPg = None
    SAMPLE = 15

    @classmethod
    def setUpClass(cls):
        try:
            cls.pg = LocalPg()
        except (subprocess.CalledProcessError, FileNotFoundError, OSError) as e:
            raise RuntimeError(f"REQUIRE_PG=1 but no local Postgres could be started: {e}") from e
        if _unsafe_host(cls.pg.env["PGHOST"]):
            raise RuntimeError("refusing a non-throwaway PGHOST")
        r = subprocess.run(["createdb", "prereq"], env=cls.pg.env, capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        r = cls.pg.psql("prereq", "-f", os.path.join(ROOT, "scripts", "aurora", "migrations", "0001_auth_shim.sql"))
        assert r.returncode == 0, r.stderr
        r = cls.pg.psql("prereq", input=PREREQ)
        assert r.returncode == 0, r.stderr

    @classmethod
    def tearDownClass(cls):
        if cls.pg:
            cls.pg.stop()

    _n = 0

    def fresh_db(self):
        TestAgainstPsql._n += 1
        name = f"m{TestAgainstPsql._n}"
        r = subprocess.run(["createdb", "-T", "prereq", name], env=self.pg.env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return name

    def drop_db(self, name):
        subprocess.run(["dropdb", "--if-exists", name], env=self.pg.env, capture_output=True)

    def dump(self, db):
        r = subprocess.run(["pg_dump", "--schema-only", "--no-owner", "-d", db], env=self.pg.env,
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return _clean_dump(r.stdout)

    def apply_split(self, db, result):
        """One statement per protocol message (\\bind -> extended protocol, which rejects
        two commands in one message), all inside one transaction — like the Data API runner."""
        parts = ["BEGIN;"]
        for st in result.statements:
            parts.append(st.sql + "\n\\bind \\g")
        parts.append("COMMIT;")
        return self.pg.psql(db, input="\n".join(parts) + "\n")

    def test_extended_protocol_rejects_merged_statements(self):
        # the B side really sends one statement per call: a merged pair fails
        db = self.fresh_db()
        r = self.pg.psql(db, input="SELECT 1 \\; SELECT 2 \\bind \\g\n")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("multiple commands", r.stderr)
        self.drop_db(db)

    def test_real_migrations_apply_identically(self):
        candidates = []
        for path in MIGRATIONS:
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
            try:
                res = split_sql(text)
            except SplitError:
                continue
            if res.non_transactional or not res.statements:
                continue
            candidates.append((-_trickiness(text), os.path.basename(path), path, res))
        candidates.sort(key=lambda c: (c[0], c[1]))
        done = []
        for _, name, path, res in candidates:
            if len(done) >= self.SAMPLE:
                break
            a = self.fresh_db()
            off = self.pg.log_size()
            ra = self.pg.psql(a, "-1", "-f", path)
            if ra.returncode != 0:          # needs objects an empty db lacks: not a candidate
                self.drop_db(a)
                continue
            sent_by_psql = self.pg.statements_logged_since(off) - 2   # psql -1's own BEGIN/COMMIT
            b = self.fresh_db()
            rb = self.apply_split(b, res)
            with self.subTest(migration=name):
                self.assertEqual(rb.returncode, 0, f"{name}: split statements failed: {rb.stderr[:500]}")
                self.assertEqual(len(res.statements) + len(res.dropped), sent_by_psql,
                                 f"{name}: splitter count differs from what psql sends")
                self.assertEqual(self.dump(a), self.dump(b), f"{name}: schema differs")
            done.append(name)
            self.drop_db(a)
            self.drop_db(b)
        self.assertGreaterEqual(len(done), self.SAMPLE, f"only {len(done)} migrations apply standalone: {done}")
        print(f"\n  psql vs splitter identical for {len(done)} migrations: " + ", ".join(done), file=sys.stderr)


if __name__ == "__main__":
    unittest.main()
