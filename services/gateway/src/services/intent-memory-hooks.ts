/**
 * VTID-01975: Memory Garden write hooks for the Intent Engine (P2-B).
 *
 * Whenever a user posts an intent, capture a small kind-discriminated
 * memory_fact via the existing write_fact() RPC (Part 1 plumbing). These
 * facts feed back into:
 *   - The proactive-prompt context-completer in orb-live.ts ("you mentioned
 *     wanting kitchen work last Tuesday").
 *   - The matcher's recency_bonus (recent stated preferences score higher).
 *   - Part 1's vitana_id profile cards — except for partner_seek which
 *     stays sensitive and never surfaces beyond the matcher.
 *
 * Fact_keys:
 *   commercial_buy   → 'willing_to_pay_for' + 'recent_buying_intent'
 *   commercial_sell  → 'services_offered'  + 'professional_skills'
 *   activity_seek    → 'activity_partner_preferences'
 *   partner_seek     → 'partner_seek_active' (TTL 60d, never community-surfaced)
 *   social_seek      → 'social_seek_topics'
 *   mutual_aid       → 'mutual_aid_inventory'
 */

import type { IntentKind } from './intent-classifier';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!;

interface IntentForMemory {
  user_id: string;
  tenant_id: string;
  intent_kind: IntentKind;
  category: string | null;
  title: string;
  scope: string;
  kind_payload: Record<string, unknown>;
}

interface FactToWrite {
  fact_key: string;
  fact_value: string;
  fact_value_type: 'text' | 'date' | 'number';
}

function buildFacts(intent: IntentForMemory): FactToWrite[] {
  const facts: FactToWrite[] = [];
  const p = intent.kind_payload || {};

  switch (intent.intent_kind) {
    case 'commercial_buy': {
      const budget = p.budget_max ? ` (~€${p.budget_max})` : '';
      facts.push({
        fact_key: 'willing_to_pay_for',
        fact_value: `${intent.category ?? 'service'}: ${intent.title}${budget}`,
        fact_value_type: 'text',
      });
      if (intent.category) {
        facts.push({
          fact_key: 'recent_buying_intent',
          fact_value: intent.category,
          fact_value_type: 'text',
        });
      }
      break;
    }
    case 'commercial_sell': {
      facts.push({
        fact_key: 'services_offered',
        fact_value: intent.title,
        fact_value_type: 'text',
      });
      if (Array.isArray(p.skill_keywords) && p.skill_keywords.length > 0) {
        facts.push({
          fact_key: 'professional_skills',
          fact_value: (p.skill_keywords as string[]).join(', '),
          fact_value_type: 'text',
        });
      }
      break;
    }
    case 'activity_seek': {
      const activity = typeof p.activity === 'string' ? p.activity : intent.category ?? 'unknown';
      const tw = Array.isArray(p.time_windows) ? (p.time_windows as string[]).join(', ') : '';
      facts.push({
        fact_key: 'activity_partner_preferences',
        fact_value: `${activity}${tw ? ` · ${tw}` : ''}`,
        fact_value_type: 'text',
      });
      break;
    }
    case 'partner_seek': {
      // Sensitive — minimum surface area. Matcher reads this; nothing else.
      const ageRange = Array.isArray(p.age_range) ? `age ${(p.age_range as number[]).join('-')}` : '';
      const radius = typeof p.location_radius_km === 'number' ? ` · ${p.location_radius_km}km` : '';
      facts.push({
        fact_key: 'partner_seek_active',
        fact_value: `${ageRange}${radius}`.trim() || 'active',
        fact_value_type: 'text',
      });
      break;
    }
    case 'social_seek': {
      const topic = typeof p.topic === 'string' ? p.topic : intent.category ?? 'general';
      facts.push({
        fact_key: 'social_seek_topics',
        fact_value: topic,
        fact_value_type: 'text',
      });
      break;
    }
    case 'mutual_aid': {
      const direction = typeof p.direction === 'string' ? p.direction : 'aid';
      const item = typeof p.object_or_skill === 'string' ? p.object_or_skill : intent.title;
      facts.push({
        fact_key: 'mutual_aid_inventory',
        fact_value: `${direction}: ${item}`,
        fact_value_type: 'text',
      });
      break;
    }
  }

  return facts;
}

/**
 * Fire-and-forget: writes the kind-discriminated facts via write_fact()
 * RPC. Never throws; failures are logged and swallowed so the post path
 * is never blocked by memory persistence.
 */
export async function writeIntentFacts(intent: IntentForMemory): Promise<void> {
  const facts = buildFacts(intent);
  if (facts.length === 0 || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return;

  await Promise.all(facts.map(async (fact) => {
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/write_fact`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
        body: JSON.stringify({
          p_tenant_id: intent.tenant_id,
          p_user_id: intent.user_id,
          p_fact_key: fact.fact_key,
          p_fact_value: fact.fact_value,
          p_entity: 'self',
          p_fact_value_type: fact.fact_value_type,
          p_provenance_source: 'assistant_inferred',
          p_provenance_confidence: 0.85,
        }),
      });
      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        console.warn(`[VTID-01975] write_fact ${fact.fact_key} failed: ${response.status} ${errBody.slice(0, 120)}`);
      }
    } catch (err: any) {
      console.warn(`[VTID-01975] write_fact ${fact.fact_key} error: ${err.message}`);
    }
  }));
}
