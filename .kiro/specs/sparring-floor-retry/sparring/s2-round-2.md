# Sparring round 2 — converged

Session: `3b3d1387-6c4d-49dd-969c-7d1ce1a43ad0` · plan hash `d7ba69f7ed665aa8815ec3e79c5fd0f83bea86de1ef3e8139e6c4af90195acf3`

## Summary

The revised plan coherently addresses all three prior findings (null-safety, 429, and the broad migration trigger). Premise checks confirm the existing code matches: gateway RETRYABLE_REASONS omits evidence_floor_not_met/partner_output_invalid (plan-sparring-service.ts L46), hasCodeAccess is Boolean(planSparringGithubToken()) (L77), created_at is selected in the repository's SESSION_COLUMNS and available on SparringSession, and ToolLogEntry currently has no status field (confirming change 1 is required). The change-1/change-2/change-3 design is internally consistent: the "no status" discriminator plus created_at cutoff robustly separates legacy from post-change-1 sessions, and change-3's re-run path correctly composes with the existing retryInfra pop/create flow. Remaining issues are minor: the deadline_exceeded exit is not among the three exits checked in change 1 (so a code-access outage manifesting as hanging/timeout fetches — which never reach the catch block or a non-ok status — is classified deadline_exceeded rather than code_access_unavailable; still retryable so no functional regression, but the label is wrong and contradicts the stated goal), the 12:00Z "token fix" cutoff is asserted without evidence (the evidence section only pins the fix to 2026-10-18 with re-pushes at 18:42Z), and the turn-cap exit citation (~L253) is imprecise (actual L250).

## Findings

### R2-F1 [minor]

Change 1 checks codeAccessFailed at only three exits (nudge ~L177, invalid-submission ~L242, turn-cap ~L250). The deadline_exceeded exit (partner.ts L129) is NOT checked, and a code-access outage that manifests as hanging/timeout fetches (not a thrown error and not a non-OK HTTP status) never populates the tool_log and falls out as deadline_exceeded. Such a session is mislabeled relative to the stated goal ('a partner that cannot reach GitHub escalates as code_access_unavailable'), though it is still retryable (deadline_exceeded is in INFRA_REASONS/RETRYABLE_REASONS). Note also the catch block (github-tools.ts L197-199) handles thrown errors as status:0, but a hanging fetch never throws and never records a status, so it is invisible to codeAccessFailed.

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/partner.ts:128` — for (let turn = 1; turn <= PARTNER_MAX_TURNS_PER_ROUND; turn++) {
      if (now() - startedAt > input.deadlineMs) return fail('deadline_exceeded', `partner pass exceeded ${input.deadlineMs}ms`);
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/github-tools.ts:142` — const resp = await doFetch(url, { method: 'GET', headers: headers() });
          if (!resp.ok) return fail(`GitHub ${resp.status} reading ${repo}/${path}@${ref}`, { path });
- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/github-tools.ts:197` — } catch (err) {
        return fail(`tool error: ${err instanceof Error ? err.message : String(err)}`);
      }

Suggestion: Either (a) also evaluate codeAccessFailed before the deadline_exceeded return and relabel to code_access_unavailable when all logged reads failed on access, or (b) explicitly document that a hanging/timeout code-access outage is intentionally classified deadline_exceeded (already retryable) and out of scope, closing the gap against goal 1.

### R2-F2 [minor]

The change-2 legacy gate hardcodes the cutoff 'before 2026-10-18T12:00Z' as 'the token fix', but the plan's own evidence section only establishes the fix as '2026-10-18' with post-fix sessions (mt-guardrails, native-g1-wiring) and re-pushes at 2026-10-18T18:42Z. No evidence supports 12:00Z specifically. If the token was actually fixed later than 12:00Z, a genuine all-failed session created in the window between 12:00Z and the real fix time would be excluded from the legacy re-run and never recover (no plan edit, no session consumed). The primary guard ('no entry carrying status') already robustly separates legacy from post-change-1 sessions, so the cutoff is a redundant safety rail whose exact value matters only for recovery completeness of any non-target broken sessions in that window.

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/plan-sparring-repository.ts:39` — const SESSION_COLUMNS =
    'id, plan_id, plan_hash, final_plan_hash, producer, change_class, trust_tier, base_ref, rounds, verdict, escalation_reasons, model_log, human_approved_by, human_approved_at, approval_evidence, approval_policy, policy_approved_at, policy_approval_rule, vtid, created_at, updated_at';

Suggestion: Pin the cutoff to a time sourced from the actual token-fix record (or widen it to a defensible bound such as before the first post-fix session's created_at), and state that evidence explicitly rather than asserting 12:00Z. Since the 'no status' check already isolates legacy sessions, a slightly-later cutoff is low-risk but should be justified.

### R2-F3 [minor]

The plan cites the turn-cap failure exit as '~L253', but the turn-cap return is at partner.ts L250 (the file ends at L252). The nudge exit is at L177 and the invalid-submission/floor exit is at L242-244, all correctly identified; only the turn-cap line number is off. No correctness impact, but imprecise citations make the implementation task ambiguous for the executor.

- `exafyltd/vitana-platform:services/gateway/src/services/plan-sparring/partner.ts:242` — if (invalidSubmissions > PARTNER_MAX_INVALID_SUBMISSIONS) {
        const floorProblem = /round 1 needs at least/.test(lastProblem);
        return fail(floorProblem ? 'evidence_floor_not_met' : 'partner_output_invalid', lastProblem);
      }

      history.push({ role: 'user', toolResults: results });
      prompt = PARTNER_CONTINUE_PROMPT;
    }
    return fail('partner_output_invalid', `partner did not submit a review within ${PARTNER_MAX_TURNS_PER_ROUND} turns`);
  }

Suggestion: Correct the turn-cap exit reference to L250 in the plan text and the change-1/test descriptions.
