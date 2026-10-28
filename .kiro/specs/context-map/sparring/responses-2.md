# Responses — round 2

```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "§3.1 now specifies atlas-pointer resolution separately from markdown tokens. Every `code` string is a pointer whatever its shape. A trailing `/` is a directory check, `*`/`**` is a glob (zero matches = dead), and the string is resolved against services/gateway/src, then services/gateway, then the repo root, first match wins. One correction to the suggestion: `../erp-bridge/` cannot be resolved relative to the atlas file's own directory, which would give services/gateway/src/orb/erp-bridge and does not exist. Like every other `code` entry, it is written relative to the gateway, so it resolves from services/gateway to services/erp-bridge/ (exists). `docs` strings are checked on their first word (`CLAUDE.md §2c` → CLAUDE.md). §5 adds a fixture test covering a live directory, a dead directory (`services/commerce/`), a live and a dead glob, a live and a dead `../` pointer, and a root-relative glob (`.github/workflows/AWS-*.yml`)."
  },
  {
    "finding_id": "R2-F2",
    "disposition": "accepted",
    "rationale": "Option (a). §5 now names it: the `gh api search/issues` call runs through an injectable runner (`vtid(roots, id, { prs, run })`, default spawnSync). The test passes a stub returning one PR line and asserts the parsed output, so no test calls GitHub and UNIT.yml needs no token or change. `--prs` is off by default, and a failing gh call prints one 'gh search failed' line instead of throwing."
  },
  {
    "finding_id": "R2-F3",
    "disposition": "accepted",
    "rationale": "Corrected §2.5 to the `code:` array lines: :77 governance-*.ts, :113 cognee-extractor-client.ts, :125 connect-people-*.ts, :149 vitana-index*.ts, :161 services/commerce/, :172 wallet*.ts and stripe*.ts, :196 erp-*.ts (verified with grep -n). The tool now cites the same lines: each pointer finding reports the line of the pointer string itself, and a route pattern that claims nothing reports the domain's key: line. A test asserts this."
  }
]
```
