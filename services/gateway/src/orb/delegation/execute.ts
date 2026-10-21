/**
 * BOOTSTRAP-ORB-DELEGATION-SCAFFOLD: Orchestrate a delegation call end-to-end.
 *
 *   route → budget-check → load credential → provider.call → log usage → return
 *
 * Every failure path emits a DelegationFailure (never throws to the caller)
 * and logs usage with status='error' / 'timeout' / 'cap_exceeded' /
 * 'unauthorized'. The orb voice session upstream of this never blocks on
 * external providers — 15 s hard timeout guarantees graceful Gemini fallback.
 */
import type {
  DelegationContext,
  DelegationOutcome,
  DelegationFailure,
} from './types';
import { routeDelegation } from './router';
import { loadUserCredential } from './credentials';
import { getProvider } from './providers';
import { checkBudget } from './budget';
import { logUsage, computeCostUsd, type UsageStatus } from './usage';

const HARD_TIMEOUT_MS = 15_000;
const DELEGATION_VTID = 'BOOTSTRAP-ORB-DELEGATION-SCAFFOLD';

export async function executeDelegation(ctx: DelegationContext): Promise<DelegationOutcome> {
  // 1. Route
  const decision = await routeDelegation(ctx);
  if (!decision) {
    return fail(ctx, {
      reason: 'no_providers_connected',
      message: 'User has no active AI assistant connections.',
    });
  }

  const adapter = getProvider(decision.providerId);
  if (!adapter) {
    return fail(ctx, {
      reason: 'provider_error',
      message: `Provider ${decision.providerId} has no registered adapter.`,
      providerId: decision.providerId,
    });
  }

  // 2. Budget check (estimate cost at 500 in / 500 out as a placeholder)
  const rates = adapter.manifest.costRates[decision.model];
  const estCost = rates ? computeCostUsd(500, 500, rates) : 0;
  const budget = await checkBudget({
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    providerId: decision.providerId,
    estimatedCostUsd: estCost,
  });
  if (!budget.allowed) {
    logUsage({
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      connectionId: null,
      providerId: decision.providerId,
      model: decision.model,
      sessionId: ctx.sessionId,
      vtid: DELEGATION_VTID,
      latencyMs: Date.now() - ctx.startedAt,
      status: 'cap_exceeded',
      taskClass: ctx.taskClass,
      errorMessage: `Monthly cap $${budget.capUsd} already $${budget.spentUsd} spent`,
    });
    return fail(ctx, {
      reason: 'budget_cap_exceeded',
      message: `Monthly cost cap reached for ${decision.providerId}.`,
      providerId: decision.providerId,
    });
  }

  // 3. Load credential
  const cred = await loadUserCredential(ctx.userId, decision.providerId);
  if (!cred || !cred.isActive) {
    return fail(ctx, {
      reason: 'no_credentials',
      message: `No active credential for ${decision.providerId}.`,
      providerId: decision.providerId,
    });
  }

  // 4. Call with hard timeout
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<DelegationOutcome>((resolve) => {
    timeoutHandle = setTimeout(() => {
      logUsage({
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        connectionId: cred.connectionId,
        providerId: decision.providerId,
        model: decision.model,
        sessionId: ctx.sessionId,
        vtid: DELEGATION_VTID,
        latencyMs: HARD_TIMEOUT_MS,
        status: 'timeout',
        taskClass: ctx.taskClass,
      });
      resolve(fail(ctx, {
        reason: 'provider_timeout',
        message: `Provider ${decision.providerId} did not respond within ${HARD_TIMEOUT_MS} ms.`,
        providerId: decision.providerId,
      }));
    }, HARD_TIMEOUT_MS);
  });

  const callPromise = (async (): Promise<DelegationOutcome> => {
    try {
      const result = await adapter.call(ctx, cred.apiKey, decision.model);
      logUsage({
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        connectionId: cred.connectionId,
        providerId: decision.providerId,
        model: decision.model,
        sessionId: ctx.sessionId,
        vtid: DELEGATION_VTID,
        latencyMs: result.latencyMs,
        status: 'ok',
        usage: result.usage,
        taskClass: ctx.taskClass,
      });
      return { ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Scaffold shipping note: until Phase 7 the adapters throw
      // scaffold_not_wired by design. We distinguish that from genuine
      // errors so it's obvious when reading telemetry.
      const status: UsageStatus = message.includes('scaffold_not_wired') ? 'error' : 'error';
      const reason = message.includes('scaffold_not_wired')
        ? 'scaffold_not_wired' as const
        : 'provider_error' as const;
      logUsage({
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        connectionId: cred.connectionId,
        providerId: decision.providerId,
        model: decision.model,
        sessionId: ctx.sessionId,
        vtid: DELEGATION_VTID,
        latencyMs: Date.now() - ctx.startedAt,
        status,
        taskClass: ctx.taskClass,
        errorMessage: message,
      });
      return fail(ctx, {
        reason,
        message,
        providerId: decision.providerId,
      });
    }
  })();

  const outcome = await Promise.race([callPromise, timeoutPromise]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  return outcome;
}

function fail(_ctx: DelegationContext, failure: DelegationFailure): DelegationOutcome {
  return { ok: false, failure };
}
