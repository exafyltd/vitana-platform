# VTID-05023 agent F: rehearsal migration runner

Status: script written and tested against a fake Data API. Not run against any cluster.

## What it does

`scripts/aws/rehearsal-apply-migrations.sh` applies the cutover migration set to the rehearsal clone
`vitana-aurora-rehearsal` through the RDS Data API. It runs one file per call, in the order of a list
file, and stops at the first failing file.

Usage:

    scripts/aws/rehearsal-apply-migrations.sh --cluster vitana-aurora-rehearsal --list <file> [--log <file>]

The `--log` default is `rehearsal-apply-migrations-<UTC time>.log` in the current directory. The
script writes nothing else.

### List file format

Agent G's `docs/validation/VTID-05023/migration-order.md` defines the order. The list file this script
reads has one entry per line:

- one migration path per line, in apply order. A relative path resolves from the repo root.
- blank lines and lines starting with `#` are ignored.
- every entry must end in `.sql` and must exist.
- an entry may be listed only once.
- `20261102052300_vtid_05573_legacy_messages_drop.sql` (the held drop) must not appear.

### Checks before any AWS call

1. `--cluster` must be exactly `vitana-aurora-rehearsal`. Anything else exits 2.
2. The whole list is read and checked first. A held drop, a missing file, a non-`.sql` entry, or a
   duplicate exits 2 before any AWS call. A refusal writes no log file.

### Apply

Each file runs through the existing `scripts/aws/aurora-apply-migration.sh` with
`AURORA_APPLY_CLUSTER=vitana-aurora-rehearsal`. That script owns the transaction, the statement split,
and the account and region guards. This runner does not re-implement any of it.

Output: one line per file, `OK <file>` or `FAILED <file>`, on stdout and in the log. For a failing
file the full apply output is also printed to stderr, which names the statement and the AWS error.
Exit codes: 0 all applied, 1 a file failed (later files not run), 2 refused.

## Change to an existing script

`scripts/aws/aurora-apply-migration.sh` hard-coded `CLUSTER=vitana-aurora-prod`, so it could not
target the rehearsal clone. The change:

    CLUSTER="${AURORA_APPLY_CLUSTER:-vitana-aurora-prod}"
    case "$CLUSTER" in
      vitana-aurora-prod|vitana-aurora-rehearsal) ;;
      *) ... refuse, exit 2 ;;
    esac

With the variable unset, the target is production exactly as before. The variable accepts only those
two names, so it cannot point the script at any other cluster. The production workflow
(`RUN-MIGRATION.yml`) does not set it. **Owner review needed:** this edit touches the production
apply path, though the default behavior is unchanged.

## Tests

`scripts/aws/test/rehearsal-apply-migrations.test.sh` uses a bash fake of `aws` on PATH. It logs every
call, answers the identity and cluster describes for the identifier it receives, and fails the
`execute-statement` whose SQL contains a marker. The real apply script runs underneath. No network and
no AWS.

Checks:

1. cluster other than `vitana-aurora-rehearsal` (prod, look-alikes, empty, missing) refused, no aws call, no log
2. held drop refused, no aws call
3. missing file and duplicate entry refused, no aws call
4. failure in the second file: first applied, second FAILED and named with its error, third never sent, exit 1
5. all files OK: one OK line per file in list order, one transaction per file, rehearsal cluster only, exit 0
6. `aurora-apply-migration.sh` refuses an `AURORA_APPLY_CLUSTER` other than the two names, no aws call

Run: `bash scripts/aws/test/rehearsal-apply-migrations.test.sh`

Exact output:

```
ok: cluster other than vitana-aurora-rehearsal (prod, look-alikes, empty, missing) refused before any aws call; no log written
ok: held drop 20261102052300_vtid_05573_legacy_messages_drop.sql refused before any aws call
ok: list entry that does not exist, or is listed twice, refused before any aws call
ok: failure in beta: alpha applied, beta FAILED and named with its error, gamma never sent, exit 1
ok: all files OK: one OK line per file in list order, one transaction per file, rehearsal cluster only, exit 0
ok: aurora-apply-migration.sh refuses an AURORA_APPLY_CLUSTER other than production or the rehearsal clone, before any aws call
PASS rehearsal-apply-migrations (6 checks)
```

## Not done in this run

- The existing `scripts/aws/test/aurora-apply-migration.sh` (run by `npm run test:aurora-migrations`) needs
  a local Postgres. None is installed in this environment, so it did not run here. Its CI job should
  run on this commit. The default-path behavior is covered by reading the diff only.
- `docs/validation/VTID-05023/migration-order.md` did not exist on `main` when this was written. The
  runner is ready for it, but the list has not been checked against it.
- Nothing was run against AWS or Aurora, as the task required.
