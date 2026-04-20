/**
 * BOOTSTRAP-ORB-DELEGATION-SCAFFOLD: Decide which connected AI provider should
 * handle a given delegation context.
 *
 * Decision order:
 *   1. Explicit user hint ("ask ChatGPT …") — if that provider is connected,
 *      use it.
 *   2. Task-class match — if the task class is set and one connected provider
 *      lists that strength and a better default doesn't, use it.
 *   3. Only connected provider — if exactly one is connected, use it.
 *   4. Fallback default — pick by provider default preference order.
 *
 * Returns null if the user has no active delegation credentials.
 */
import type {
  DelegationContext,
  DelegationDecision,
  DelegationProviderId,
  DelegationStrength,
} from './types';
import { listActiveProviders } from './credentials';
import { getProvider } from './providers';

// Provider preference order when nothing else decides. Tuned once, override
// per-user later via a settings table in Phase 9.
const DEFAULT_PROVIDER_ORDER: DelegationProviderId[] = ['claude', 'chatgpt', 'google-ai'];

export async function routeDelegation(ctx: DelegationContext): Promise<DelegationDecision | null> {
  const connected = await listActiveProviders(ctx.userId);
  if (connected.length === 0) return null;

  // 1. Explicit user hint
  if (ctx.providerHint && connected.includes(ctx.providerHint)) {
    const adapter = getProvider(ctx.providerHint);
    if (adapter) {
      return {
        providerId: ctx.providerHint,
        model: adapter.manifest.defaultModel,
        reason: 'user_hint',
      };
    }
  }

  // 2. Task-class match: rank connected providers by whether their strengths list includes the task class
  if (ctx.taskClass) {
    const ranked = rankByStrength(connected, ctx.taskClass);
    if (ranked.length > 0) {
      const top = ranked[0];
      const adapter = getProvider(top.providerId);
      if (adapter && top.score > 0) {
        return {
          providerId: top.providerId,
          model: adapter.manifest.defaultModel,
          reason: 'task_class_match',
          score: top.score,
        };
      }
    }
  }

  // 3. Only one connected
  if (connected.length === 1) {
    const only = connected[0];
    const adapter = getProvider(only);
    if (adapter) {
      return { providerId: only, model: adapter.manifest.defaultModel, reason: 'only_connected' };
    }
  }

  // 4. Fallback default — first from preference order that is connected
  for (const pref of DEFAULT_PROVIDER_ORDER) {
    if (connected.includes(pref)) {
      const adapter = getProvider(pref);
      if (adapter) {
        return { providerId: pref, model: adapter.manifest.defaultModel, reason: 'fallback_default' };
      }
    }
  }

  return null;
}

interface RankedProvider {
  readonly providerId: DelegationProviderId;
  readonly score: number;
}

function rankByStrength(
  connected: DelegationProviderId[],
  taskClass: DelegationStrength,
): RankedProvider[] {
  const ranked: RankedProvider[] = [];
  for (const pid of connected) {
    const adapter = getProvider(pid);
    if (!adapter) continue;
    // Simple score: 1 if listed in strengths, 0 otherwise. Ties broken by
    // DEFAULT_PROVIDER_ORDER (we sort stably and use order index as secondary).
    const score = adapter.manifest.strengths.includes(taskClass) ? 1 : 0;
    ranked.push({ providerId: pid, score });
  }
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ai = DEFAULT_PROVIDER_ORDER.indexOf(a.providerId);
    const bi = DEFAULT_PROVIDER_ORDER.indexOf(b.providerId);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  return ranked;
}
