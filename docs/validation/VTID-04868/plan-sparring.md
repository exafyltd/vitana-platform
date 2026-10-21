# Plan sparring record — VTID-04868 (Plan Sparring Gate)

The first sparring record, made by hand in a Claude Code session before the gateway tier existed.
Full plan with every revision and the planner's responses to each finding:
[`plan-B-sparring.md`](./plan-B-sparring.md). File sha256 at owner approval:
`82eab6cbaaa93976a50e25553e70539410bec762626d2dbe95a2cfe9cf4d6344`.

- **Producer:** claude-code (session_01ESw1mpd9mLUjEmXG7d2Gd5)
- **Class:** standard
- **Partner:** read-only general-purpose subagent. Its model was the same as the planner's
  (Opus 5.5), because the Opus 4.6 partner did not exist yet. Recorded as a known limit of this
  first run.
- **Verdict:** ESCALATED after 3 rounds, because the remaining open items were owner decisions.
  The owner decided them on 2026-10-04. A light re-spar of the material changes then ran 2 passes
  and reached **CONVERGED**.
- **Owner approval:** "Yes", 2026-10-04, in session.

## Findings ledger

| Round | ID | Sev | Finding (short) | Outcome |
|---|---|---|---|---|
| 1 | F1 | blocker | No enforcement chokepoint: sessions and `operator.ts:1516` bypass a rule or gateway check | accepted → DB trigger |
| 1 | F2 | blocker | "Spar at spec stage" for autonomous producers contradicts the directive | accepted → incident_id correlation |
| 1 | F3 | blocker | OASIS events need a VTID and a closed union | accepted → events emitted at allocation |
| 1 | F4 | major | Reuse the spec pipeline (spec-quality-agent, oasis_specs hash) | accepted |
| 1 | F5 | major | Hash binding undefined | accepted |
| 1 | F6 | major | Stage wiring wrong; DeepSeek fallback | accepted |
| 1 | F7 | major | Partner independence not guaranteed | accepted |
| 1 | F8 | major | No hotfix path | accepted → expedited mode |
| 1 | F9 | major | Self-declared trivial exemption is abusable | accepted → CI-verified class |
| 1 | F10 | major | Autonomous volume and cost unbounded | accepted → budgets and dedup |
| 1 | F11 | major | Regression suites would break | accepted |
| 1 | F12–F15 | minor | Approval identity; rollout exit criteria; disputed state; record location | accepted |
| 2 | N1 | blocker | Attested tier lets a session forge its own gate | accepted → verified-actor approval only |
| 2 | N2 | blocker | GUC mode switch bypassable; trigger tamperable | accepted (config table and reconciler); settings change escalated to owner |
| 2 | N3 | major | RPC overload is ambiguous and anon-executable | accepted |
| 2 | N4 | major | Trigger breaks upserts and repairs | accepted |
| 2 | N5 | major | Light class with 1 round is not ping-pong | accepted → ≥2 passes |
| 2 | N6–N9 | minor | Hash scope; dedup vs binding; RLS; partner Bash | accepted (N9: partner limited to Read/Grep/Glob) |
| 3 | N10 | major | Incident deadlock when gateway or Bedrock is down | accepted → break-glass |
| 3 | N11 | major | Exemption role assumable via `execute_sql` | accepted; residual on Supabase |
| re-spar | R1 | major | Partner would reuse a merge-capable GitHub token | accepted → dedicated read-only token |
| re-spar | R2 | major | Bedrock adapter drops thinking blocks | accepted |
| re-spar | R3 | major | No-fallback only half-enforced | accepted |
| re-spar | R4 | major | Aurora DMS replication bypasses or trips the trigger | accepted → build on Supabase now; Aurora at cutover |
| re-spar | R5, N12 | minor | eu profile id; router history passthrough | accepted |

## Owner decisions (2026-10-04)
1. `execute_sql` stays allowed. The accepted residual is: detected, not prevented.
2. Break-glass holder is the owner. Post-hoc sparring is due within 24 hours.
3. The target database is Aurora.
4. `/vtid/allocate-internal` and `/vtid/create` are kept.
5. A light change needs one click.
6. The partner model is **Bedrock Claude Opus 4.6**, with no fallback.

## Preconditions (each escalates if it fails)
- The Opus 4.6 `eu.*` inference profile resolves, and a real invoke succeeds, including a tool
  round-trip.
- Bedrock accepts `output_config.effort`.
- `PLAN_SPARRING_GITHUB_TOKEN` (contents:read) is provisioned.
