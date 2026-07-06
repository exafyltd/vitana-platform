/**
 * Feedback-ticket + Settings voice tools (VTID-02768, VTID-02772).
 *
 * Feedback (VTID-02768): typed shortcuts over the unified feedback pipeline
 * (VTID-02047). Each submit_* tool files a `feedback_tickets` row of a fixed
 * `kind` and confirms — it does NOT persona-swap the live call (that is
 * report_to_specialist's job). Specialist resolution reuses the same
 * persona-registry lookup the pipeline uses (`pickPersonaForKind[ForTenant]`,
 * which reads the `agent_personas_registry` view — status='active' only), so
 * the VTID-03044 Devon-only canary is honoured automatically: bug reports
 * triage to devon; support / marketplace / account tickets file as unrouted
 * ('new') until Sage / Atlas / Mira are re-enabled. When a specialist
 * resolves, the ticket is created through the shared
 * `executeReportToSpecialist` core (same insert + handoff event + OASIS
 * emit); the two-gate consent RPC is intentionally bypassed via
 * specialist_hint because calling a typed submit tool IS the explicit filing
 * intent.
 *
 * Settings (VTID-02772): writes the SAME storage the app reads —
 * `user_preferences.stt_language` (frontend Language picker) +
 * `app_users.locale` (gateway i18n canonical) for language;
 * `user_preferences.tts_*` for voice prefs; `social_connections` (connector
 * dispatcher's token store) + `user_connections` (category='ai_assistant')
 * for connected apps. Theme is device-local (next-themes localStorage in
 * vitana-v1) — no server column exists, so set_theme answers gracefully.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { executeReportToSpecialist } from '../report-to-specialist-core';
import {
  pickPersonaForKind,
  pickPersonaForKindForTenant,
} from '../persona-registry';
import { emitOasisEvent } from '../oasis-event-service';
import {
  disconnectSocialAccount,
  getUserConnections,
  SUPPORTED_PROVIDERS,
  type SocialProvider,
} from '../social-connect-service';
import { invalidateUserLocale } from '../../i18n/server-locale';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

const TICKET_SOURCE = 'orb-voice-typed-tool';
const DEFAULT_SCREEN_PATH = '/orb/voice';

// ---------------------------------------------------------------------------
// Feedback tickets (VTID-02768)
// ---------------------------------------------------------------------------

type TypedTicketKind =
  | 'bug'
  | 'support_question'
  | 'marketplace_claim'
  | 'account_issue';

const KIND_LABEL: Record<TypedTicketKind, string> = {
  bug: 'bug report',
  support_question: 'support question',
  marketplace_claim: 'marketplace dispute',
  account_issue: 'account issue',
};

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function askForSpecifics(toolName: string, words: number, minWords: number): OrbToolResult {
  return {
    ok: true,
    result: { decision: 'needs_details', word_count: words, min_words: minWords },
    text:
      `ASK_FOR_SPECIFICS: The summary is too short (${words} words, need at least ${minWords}). ` +
      `Do NOT call ${toolName} again yet. Ask the user ONE follow-up question in their language ` +
      `for concrete details (what exactly happened, which screen or feature, what they expected). ` +
      `Then call ${toolName} again with a fuller summary in the user's own words. ` +
      `Do not mention this internal check out loud.`,
  };
}

function ticketFiledInstruction(
  ticketNumber: string,
  kind: TypedTicketKind,
  specialist: string | null,
): string {
  const routing = specialist
    ? 'It is already with our tech-support colleague.'
    : 'Our team will pick it up and follow up.';
  return (
    `Ticket ${ticketNumber} filed (${KIND_LABEL[kind]}). ${routing} ` +
    `Tell the user warmly in their language that the report is filed — mention the ticket number ONCE ` +
    `so they can refer to it later. NEVER speak internal specialist names (Devon, Sage, Atlas, Mira). ` +
    `Do not switch persona. Then STOP.`
  );
}

/**
 * Shared filing path for the four typed submit_* tools.
 *
 * 1. Resolve the owning specialist from the persona registry (active
 *    personas only — VTID-03044 canary means only devon resolves today).
 * 2. Specialist found → reuse `executeReportToSpecialist` with that hint
 *    (identical ticket insert + feedback_handoff_events + OASIS emit as
 *    report_to_specialist; the hint deterministically skips the two-gate
 *    consent RPC, which is correct here — the typed tool call IS consent).
 * 3. No enabled specialist → insert the ticket unrouted (status 'new',
 *    resolver_agent null), mirroring the core's unrouted branch, and emit
 *    the same `feedback.ticket.created` OASIS event.
 */
async function createTypedTicket(
  toolName: string,
  kind: TypedTicketKind,
  minWords: number,
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
  extraFields: Record<string, unknown> = {},
): Promise<OrbToolResult> {
  if (!id.user_id) {
    return { ok: false, error: `${toolName} requires an authenticated user.` };
  }
  const summary = String(args.summary ?? '').trim();
  if (!summary) {
    return { ok: false, error: 'summary is required' };
  }
  const words = wordCount(summary);
  if (words < minWords) {
    return askForSpecifics(toolName, words, minWords);
  }

  const screenPath = String(args.screen ?? '').trim() || DEFAULT_SCREEN_PATH;

  // Same registry resolution the pipeline uses. Only status='active'
  // personas resolve (VTID-03044: devon only), so this cannot route to a
  // disabled specialist.
  let specialist: string | null = null;
  try {
    specialist = id.tenant_id
      ? await pickPersonaForKindForTenant(kind, id.tenant_id)
      : await pickPersonaForKind(kind);
  } catch {
    specialist = null;
  }

  try {
    if (specialist) {
      const result = await executeReportToSpecialist(
        { kind, summary, specialist_hint: specialist },
        {
          user_id: id.user_id,
          tenant_id: id.tenant_id ?? null,
          vitana_id: id.vitana_id ?? null,
          lang: id.lang ?? null,
        },
        sb,
        { gate_input: summary, source: TICKET_SOURCE, screen_path: screenPath },
      );
      switch (result.decision) {
        case 'failed':
          return { ok: false, error: result.error };
        case 'vague':
          return {
            ok: true,
            result: { decision: 'needs_details', word_count: result.word_count },
            text: result.llm_instruction,
          };
        case 'stay_inline':
          // Defensive — cannot happen with a specialist_hint set, but keep
          // the LLM instruction honest if the core ever changes.
          return {
            ok: true,
            result: { decision: 'stay_inline', rpc_gate: result.rpc_gate },
            text: result.llm_instruction,
          };
        case 'created':
          return {
            ok: true,
            result: {
              decision: 'created',
              ticket_id: result.ticket.id,
              ticket_number: result.ticket.ticket_number,
              kind,
              specialist: result.persona,
            },
            text: ticketFiledInstruction(
              result.ticket.ticket_number ?? '(pending)',
              kind,
              result.persona,
            ),
          };
      }
    }

    // Unrouted path — mirrors executeReportToSpecialist's insert shape when
    // no specialist is enabled (VTID-03044: support/marketplace/account).
    const { data: created, error: insertError } = await sb
      .from('feedback_tickets')
      .insert({
        user_id: id.user_id,
        vitana_id: id.vitana_id ?? null,
        kind,
        status: 'new',
        raw_transcript: summary,
        intake_messages: [
          { agent: 'vitana', role: 'user', content: summary, ts: new Date().toISOString() },
        ],
        structured_fields: {
          specialist_hint: null,
          voice_origin: true,
          source: TICKET_SOURCE,
          ...extraFields,
        },
        screen_path: screenPath,
        resolver_agent: null,
        triaged_at: null,
      })
      .select('id, ticket_number')
      .single();

    if (insertError || !created) {
      return {
        ok: false,
        error: `feedback_tickets insert failed: ${insertError?.message ?? 'no row returned'}`,
      };
    }
    const ticket = created as { id: string; ticket_number: string | null };

    try {
      await emitOasisEvent({
        vtid: 'VTID-02768',
        type: 'feedback.ticket.created' as never,
        source: TICKET_SOURCE,
        status: 'info',
        message: `Voice tool ${toolName} created ticket ${ticket.ticket_number ?? '(pending)'} (${kind}) → unrouted`,
        payload: {
          ticket_id: ticket.id,
          ticket_number: ticket.ticket_number,
          kind,
          specialist: null,
          voice_origin: true,
          source: TICKET_SOURCE,
        },
        actor_id: id.user_id,
        actor_role: 'user',
        surface: 'orb',
        vitana_id: id.vitana_id ?? undefined,
      });
    } catch {
      /* non-blocking — the ticket is the source of truth */
    }

    return {
      ok: true,
      result: {
        decision: 'created',
        ticket_id: ticket.id,
        ticket_number: ticket.ticket_number,
        kind,
        specialist: null,
      },
      text: ticketFiledInstruction(ticket.ticket_number ?? '(pending)', kind, null),
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : `${toolName} failed` };
  }
}

export async function tool_submit_bug_report(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const screen = String(args.screen ?? '').trim();
  return createTypedTicket(
    'submit_bug_report', 'bug', 15, args, id, sb,
    screen ? { screen } : {},
  );
}

export async function tool_submit_support_ticket(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  return createTypedTicket('submit_support_ticket', 'support_question', 12, args, id, sb);
}

export async function tool_submit_marketplace_dispute(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  const orderReference = String(args.order_reference ?? '').trim();
  return createTypedTicket(
    'submit_marketplace_dispute', 'marketplace_claim', 12, args, id, sb,
    orderReference ? { order_reference: orderReference } : {},
  );
}

export async function tool_submit_account_issue(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  return createTypedTicket('submit_account_issue', 'account_issue', 12, args, id, sb);
}

// Open = anything before a terminal status. Matches the "active tickets"
// partial index on feedback_tickets (priority, status).
const CLOSED_STATUSES = ['resolved', 'user_confirmed', 'rejected', 'wont_fix', 'duplicate'];

const SPEAKABLE_STATUS: Record<string, string> = {
  new: 'received',
  interviewing: 'in intake',
  triaged: 'with the team',
  spec_pending: 'being scoped',
  spec_ready: 'scoped and queued',
  answer_pending: 'being answered',
  answer_ready: 'answer ready for you',
  approved: 'approved for work',
  in_progress: 'in progress',
  needs_more_info: 'waiting on more info from you',
  reopened: 'reopened',
};

export async function tool_list_my_tickets(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) {
    return { ok: false, error: 'list_my_tickets requires an authenticated user.' };
  }
  try {
    const { data, error } = await sb
      .from('feedback_tickets')
      .select('id, ticket_number, kind, status, created_at')
      .eq('user_id', id.user_id)
      .not('status', 'in', `(${CLOSED_STATUSES.join(',')})`)
      .order('created_at', { ascending: false })
      .limit(8);
    if (error) {
      return { ok: false, error: `Could not load tickets: ${error.message}` };
    }
    const rows = (data ?? []) as Array<{
      id: string;
      ticket_number: string | null;
      kind: string;
      status: string;
      created_at: string;
    }>;

    if (rows.length === 0) {
      return {
        ok: true,
        result: { tickets: [], total: 0 },
        text:
          'The user has NO open tickets right now. Say so plainly in their language — ' +
          'everything they reported is either resolved or they have not filed anything yet.',
      };
    }

    const lines = rows.map((t) => {
      const kindLabel = KIND_LABEL[t.kind as TypedTicketKind] ?? t.kind.replace(/_/g, ' ');
      const statusLabel = SPEAKABLE_STATUS[t.status] ?? t.status.replace(/_/g, ' ');
      const filed = String(t.created_at ?? '').slice(0, 10);
      return `${t.ticket_number ?? '(pending)'} — ${kindLabel}, ${statusLabel}, filed ${filed}`;
    });
    return {
      ok: true,
      result: { tickets: rows, total: rows.length },
      text:
        `The user has ${rows.length} open ticket(s): ${lines.join('; ')}. ` +
        `Read them back naturally in the user's language — ticket number, what it is, and its status. ` +
        `Do not mention internal specialist names.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'list_my_tickets failed' };
  }
}

// ---------------------------------------------------------------------------
// Settings (VTID-02772)
// ---------------------------------------------------------------------------

const SUPPORTED_LANGUAGES: Record<string, { full: string; name: string }> = {
  de: { full: 'de-DE', name: 'German (Deutsch)' },
  en: { full: 'en-US', name: 'English' },
  es: { full: 'es-ES', name: 'Spanish (Español)' },
  sr: { full: 'sr-RS', name: 'Serbian (Srpski)' },
};

export async function tool_set_language(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) {
    return { ok: false, error: 'set_language requires an authenticated user.' };
  }
  const raw = String(args.language ?? '').trim().toLowerCase();
  const short = raw.split('-')[0];
  const lang = SUPPORTED_LANGUAGES[short];
  if (!lang) {
    return {
      ok: false,
      error: `Unsupported language "${raw}". Supported: de (German), en (English), es (Spanish), sr (Serbian).`,
    };
  }
  try {
    // Primary store: user_preferences.stt_language — the column the frontend
    // Language picker writes and the gateway i18n resolver reads as its live
    // fallback. UNIQUE(user_id) → upsert.
    const { error: prefError } = await sb.from('user_preferences').upsert(
      {
        user_id: id.user_id,
        stt_language: lang.full,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );
    if (prefError) {
      return { ok: false, error: `Could not save language: ${prefError.message}` };
    }

    // Canonical i18n column (app_users.locale) — best-effort update; the row
    // may not exist for pre-provisioned users and stt_language already wins
    // for runtime resolution.
    let appUsersUpdated = true;
    try {
      const { error: appUserError } = await sb
        .from('app_users')
        .update({ locale: short, updated_at: new Date().toISOString() })
        .eq('user_id', id.user_id);
      if (appUserError) appUsersUpdated = false;
    } catch {
      appUsersUpdated = false;
    }

    // Bust the gateway's 5-minute per-user locale cache so notifications and
    // server-emitted strings switch immediately.
    try {
      invalidateUserLocale(id.user_id);
    } catch {
      /* cache invalidation is best-effort */
    }

    return {
      ok: true,
      result: {
        language: short,
        stt_language: lang.full,
        app_users_locale_updated: appUsersUpdated,
      },
      text:
        `Language saved: ${lang.name}. From this moment on, respond ONLY in ${lang.name}. ` +
        `Tell the user (in ${lang.name}) that their language is now set — the app screens follow on the next reload.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'set_language failed' };
  }
}

export async function tool_set_theme(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  _sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) {
    return { ok: false, error: 'set_theme requires an authenticated user.' };
  }
  const theme = String(args.theme ?? '').trim().toLowerCase();
  if (theme && !['light', 'dark', 'system'].includes(theme)) {
    return { ok: false, error: `Unknown theme "${theme}". Options: light, dark, system.` };
  }
  // No server-side theme column exists: the app stores light/dark/system on
  // the device (next-themes → localStorage), so a voice tool cannot persist
  // it. Answer gracefully and point at the real switch.
  return {
    ok: true,
    result: { persisted: false, requested_theme: theme || null },
    text:
      `The visual theme (light / dark / system) is a device setting stored in the app itself — ` +
      `it cannot be changed from here. Tell the user in their language to open ` +
      `Settings → Preferences and pick ${theme ? `"${theme}"` : 'light, dark, or system'} under Theme — it applies instantly on that device.`,
  };
}

const PACE_TO_SPEED: Record<string, number> = { slow: 0.8, normal: 1.0, fast: 1.2 };

export async function tool_set_voice_preferences(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) {
    return { ok: false, error: 'set_voice_preferences requires an authenticated user.' };
  }
  const pace = String(args.pace ?? '').trim().toLowerCase();
  const voice = String(args.voice ?? '').trim();
  const tone = String(args.tone ?? '').trim();

  if (!pace && !voice && !tone) {
    return {
      ok: false,
      error: 'Nothing to change — provide at least one of: pace (slow/normal/fast), voice, tone.',
    };
  }
  if (pace && PACE_TO_SPEED[pace] === undefined) {
    return { ok: false, error: `Unknown pace "${pace}". Options: slow, normal, fast.` };
  }

  try {
    const update: Record<string, unknown> = {
      user_id: id.user_id,
      updated_at: new Date().toISOString(),
    };
    const changes: string[] = [];
    if (pace) {
      update.tts_speed = PACE_TO_SPEED[pace];
      changes.push(`pace ${pace} (${PACE_TO_SPEED[pace]}x)`);
    }
    if (voice) {
      update.tts_voice = voice;
      changes.push(`voice "${voice}"`);
    }
    if (tone) {
      update.tts_character = tone;
      changes.push(`tone "${tone}"`);
    }

    const { error } = await sb
      .from('user_preferences')
      .upsert(update, { onConflict: 'user_id' });
    if (error) {
      return { ok: false, error: `Could not save voice preferences: ${error.message}` };
    }

    return {
      ok: true,
      result: {
        saved: true,
        tts_speed: (update.tts_speed as number) ?? null,
        tts_voice: voice || null,
        tts_character: tone || null,
      },
      text:
        `Voice preferences saved: ${changes.join(', ')}. Tell the user in their language that ` +
        `their spoken-voice settings are updated — the app's speech output uses them from the next reply on.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'set_voice_preferences failed' };
  }
}

const PROVIDER_DISPLAY: Record<string, string> = {
  google: 'Google',
  youtube: 'YouTube',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  linkedin: 'LinkedIn',
  twitter: 'X (Twitter)',
  spotify: 'Spotify',
  openai: 'OpenAI (ChatGPT)',
  anthropic: 'Anthropic (Claude)',
  gemini: 'Google Gemini',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
};

function displayProvider(key: string): string {
  return PROVIDER_DISPLAY[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

// Spoken names → connection keys (users say "Claude", not "anthropic").
const PROVIDER_ALIASES: Record<string, string> = {
  x: 'twitter',
  chatgpt: 'openai',
  claude: 'anthropic',
  gmail: 'google',
  'youtube music': 'youtube',
};

async function loadAiConnections(
  sb: SupabaseClient,
  userId: string,
): Promise<Array<{ connector_id: string; connected_at: string | null }>> {
  const { data, error } = await sb
    .from('user_connections')
    .select('connector_id, connected_at')
    .eq('user_id', userId)
    .eq('category', 'ai_assistant')
    .eq('is_active', true);
  if (error) return [];
  return (data ?? []) as Array<{ connector_id: string; connected_at: string | null }>;
}

export async function tool_list_connected_apps(
  _args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) {
    return { ok: false, error: 'list_connected_apps requires an authenticated user.' };
  }
  try {
    const [social, ai] = await Promise.all([
      getUserConnections(sb, id.user_id),
      loadAiConnections(sb, id.user_id),
    ]);

    const entries: Array<{ provider: string; category: string; connected_at: string | null }> = [
      ...social.map((c) => ({
        provider: c.provider as string,
        category: 'app',
        connected_at: c.connected_at ?? null,
      })),
      ...ai.map((c) => ({
        provider: c.connector_id,
        category: 'ai_assistant',
        connected_at: c.connected_at,
      })),
    ];

    if (entries.length === 0) {
      return {
        ok: true,
        result: { connections: [], total: 0 },
        text:
          'The user has NO connected apps yet. Say so plainly in their language, and mention they ' +
          'can link Google, YouTube, or an AI assistant under Settings → Connected Apps.',
      };
    }

    const spoken = entries.map((e) => {
      const since = e.connected_at ? `, connected ${String(e.connected_at).slice(0, 10)}` : '';
      return `${displayProvider(e.provider)}${e.category === 'ai_assistant' ? ' (AI assistant)' : ''}${since}`;
    });
    return {
      ok: true,
      result: { connections: entries, total: entries.length },
      text:
        `The user has ${entries.length} connected app(s): ${spoken.join('; ')}. ` +
        `List them naturally in the user's language. They can manage them under Settings → Connected Apps.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'list_connected_apps failed' };
  }
}

export async function tool_disconnect_app(
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
): Promise<OrbToolResult> {
  if (!id.user_id) {
    return { ok: false, error: 'disconnect_app requires an authenticated user.' };
  }
  const rawProvider = String(args.provider ?? '').trim().toLowerCase();
  if (!rawProvider) {
    return { ok: false, error: 'provider is required (e.g. google, youtube, instagram, openai).' };
  }
  const provider = PROVIDER_ALIASES[rawProvider] ?? rawProvider;
  const display = displayProvider(provider);

  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, provider },
      text:
        `Disconnecting ${display} removes its access — features that rely on it stop working until it is ` +
        `reconnected. Ask the user in their language to confirm they really want to disconnect ${display}. ` +
        `Only after an explicit yes, call disconnect_app again with confirm=true. If they hesitate, do nothing.`,
    };
  }

  try {
    // 1) Social / OAuth connector (the token store the connector dispatcher
    //    reads for read_email / play_music etc.) — reuse the exact service
    //    function the settings route (POST /social/disconnect/:provider) uses.
    if ((SUPPORTED_PROVIDERS as string[]).includes(provider)) {
      const { data: socialRow } = await sb
        .from('social_connections')
        .select('id')
        .eq('user_id', id.user_id)
        .eq('provider', provider)
        .eq('is_active', true)
        .maybeSingle();
      if (socialRow) {
        const result = await disconnectSocialAccount(sb, id.user_id, provider as SocialProvider);
        if (!result.ok) {
          return { ok: false, error: `Could not disconnect ${display}: ${result.error ?? 'unknown error'}` };
        }
        return {
          ok: true,
          result: { disconnected: true, provider, category: 'app' },
          text:
            `${display} is disconnected. Confirm to the user in their language, and mention they can ` +
            `reconnect anytime under Settings → Connected Apps.`,
        };
      }
    }

    // 2) AI assistant connection — same soft-disconnect + credential purge
    //    the settings route (DELETE /api/v1/ai-assistants/:provider) performs.
    const { data: aiRow } = await sb
      .from('user_connections')
      .select('id')
      .eq('user_id', id.user_id)
      .eq('connector_id', provider)
      .eq('category', 'ai_assistant')
      .eq('is_active', true)
      .maybeSingle();
    if (aiRow) {
      const { error: updErr } = await sb
        .from('user_connections')
        .update({ is_active: false, disconnected_at: new Date().toISOString() })
        .eq('id', (aiRow as { id: string }).id);
      if (updErr) {
        return { ok: false, error: `Could not disconnect ${display}: ${updErr.message}` };
      }
      // Purge the stored API key (overwrite with zero bytes, keep the row
      // for audit) — mirrors the ai-assistants disconnect route.
      try {
        await sb
          .from('ai_assistant_credentials')
          .update({
            encrypted_key: `\\x${'00'.repeat(32)}`,
            encryption_iv: `\\x${'00'.repeat(12)}`,
            encryption_tag: `\\x${'00'.repeat(16)}`,
            last_verify_status: 'purged',
          })
          .eq('connection_id', (aiRow as { id: string }).id);
      } catch {
        /* row stays disconnected even if the purge write fails */
      }
      return {
        ok: true,
        result: { disconnected: true, provider, category: 'ai_assistant' },
        text:
          `${display} is disconnected and its stored key was removed. Confirm to the user in their ` +
          `language; they can reconnect it under Settings → Connected Apps.`,
      };
    }

    return {
      ok: true,
      result: { disconnected: false, provider, reason: 'not_connected' },
      text:
        `${display} is not connected — there is nothing to disconnect. Tell the user plainly in their ` +
        `language; offer to list their connected apps if helpful.`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'disconnect_app failed' };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const FEEDBACK_SETTINGS_TOOL_HANDLERS: Record<string, Handler> = {
  submit_bug_report: tool_submit_bug_report,
  submit_support_ticket: tool_submit_support_ticket,
  submit_marketplace_dispute: tool_submit_marketplace_dispute,
  submit_account_issue: tool_submit_account_issue,
  list_my_tickets: tool_list_my_tickets,
  set_language: tool_set_language,
  set_theme: tool_set_theme,
  set_voice_preferences: tool_set_voice_preferences,
  list_connected_apps: tool_list_connected_apps,
  disconnect_app: tool_disconnect_app,
};

export const FEEDBACK_SETTINGS_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'submit_bug_report',
    description: [
      'File a bug ticket (kind=bug) in the feedback pipeline. No persona swap —',
      'just files and confirms. Call when the user describes something BROKEN and',
      'wants it reported: "melde diesen Fehler", "die App stürzt ab, bitte melden",',
      '"report this bug", "the button does nothing, file it".',
      'The summary must be a concrete description of at least 15 words in the',
      'user\'s own words — which screen, what happened, what was expected.',
      'AFTER: speak the ticket number once and say the team will follow up.',
      'For live handoff to a specialist use report_to_specialist instead.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Concrete bug description, at least 15 words, in the user\'s own words (what broke, where, what was expected).',
        },
        screen: {
          type: 'string',
          description: 'Optional: the screen or feature where the bug happened (e.g. /events, profile page).',
        },
      },
      required: ['summary'],
    },
  },
  {
    name: 'submit_support_ticket',
    description: [
      'File a support ticket (kind=support_question) for a question the team',
      'should answer offline. Call when the user explicitly wants their question',
      'logged for support: "erstell ein Support-Ticket", "leite meine Frage an den',
      'Support weiter", "open a support ticket", "log this question for support".',
      'Do NOT call for how-to questions you can answer yourself — answer inline.',
      'Summary: at least 12 words describing the question and context.',
      'AFTER: speak the ticket number once and say support will follow up.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'The user\'s question with context, at least 12 words.',
        },
      },
      required: ['summary'],
    },
  },
  {
    name: 'submit_marketplace_dispute',
    description: [
      'File a marketplace dispute ticket (kind=marketplace_claim): refunds, wrong',
      'or damaged items, orders that never arrived, seller issues, overcharges.',
      'Triggers: "ich will mein Geld zurück", "die Bestellung ist nie angekommen",',
      '"I want a refund", "the seller sent the wrong item, file a claim".',
      'Summary: at least 12 words — what was ordered, what went wrong, what the',
      'user wants (refund / replacement). Include the order number if they have it.',
      'AFTER: speak the ticket number once and say the team will review the claim.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Dispute description, at least 12 words: item, problem, desired outcome.',
        },
        order_reference: {
          type: 'string',
          description: 'Optional: order number or reference the user mentions.',
        },
      },
      required: ['summary'],
    },
  },
  {
    name: 'submit_account_issue',
    description: [
      'File an account ticket (kind=account_issue): login problems, password or',
      'email trouble, role/permission issues, profile data corrections, lockouts.',
      'Triggers: "ich komme nicht in mein Konto", "meine E-Mail stimmt nicht,',
      'bitte melden", "I\'m locked out", "report my login problem".',
      'NEVER ask for or record passwords. Summary: at least 12 words describing',
      'the account problem and what the user already tried.',
      'AFTER: speak the ticket number once and say the team will follow up.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Account problem description, at least 12 words. Never include passwords.',
        },
      },
      required: ['summary'],
    },
  },
  {
    name: 'list_my_tickets',
    description: [
      'List the user\'s OPEN feedback tickets (bugs, support, disputes, account)',
      'with number and status. Call when the user asks about their reports:',
      '"was ist mit meinen Tickets?", "wie steht es um meine Fehlermeldung?",',
      '"what happened to my bug report?", "show my open tickets".',
      'AFTER: read back ticket number, what it is, and its status in the user\'s',
      'language. Never mention internal specialist names.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'set_language',
    description: [
      'Set the user\'s app + voice language. Persists the same setting the app\'s',
      'Language picker writes, so screens and notifications follow. Call when the',
      'user asks to switch language: "stell auf Deutsch um", "sprich Englisch mit',
      'mir", "switch the app to English", "cambia a español".',
      'AFTER: respond ONLY in the new language from that moment on and confirm',
      'the change; the app screens follow on the next reload.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['de', 'en', 'es', 'sr'],
          description: 'Target language code: de (German), en (English), es (Spanish), sr (Serbian).',
        },
      },
      required: ['language'],
    },
  },
  {
    name: 'set_theme',
    description: [
      'Handle a request to change the visual theme (light / dark / system).',
      'Triggers: "mach den Dunkelmodus an", "stell auf hell", "switch to dark',
      'mode", "use the system theme".',
      'NOTE: the theme is stored on the device, not on the server — this tool',
      'explains where to flip it (Settings → Preferences → Theme). Relay that',
      'guidance in the user\'s language; do not promise the theme changed.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        theme: {
          type: 'string',
          enum: ['light', 'dark', 'system'],
          description: 'The theme the user asked for.',
        },
      },
      required: [],
    },
  },
  {
    name: 'set_voice_preferences',
    description: [
      'Tune the app\'s spoken-voice settings: pace (slow / normal / fast), voice',
      'name, and tone/character. Persists to the same voice settings the app\'s',
      'Voice & AI screen uses. Triggers: "sprich langsamer", "sprich schneller",',
      '"klinge ruhiger", "speak slower please", "use a calmer tone".',
      'Provide only the fields the user asked to change.',
      'AFTER: confirm briefly what changed, in the user\'s language.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        pace: {
          type: 'string',
          enum: ['slow', 'normal', 'fast'],
          description: 'Speaking speed the user asked for.',
        },
        voice: {
          type: 'string',
          description: 'Optional: a specific voice name the user asked for.',
        },
        tone: {
          type: 'string',
          description: 'Optional: tone/character, e.g. friendly, calm, energetic, professional.',
        },
      },
      required: [],
    },
  },
  {
    name: 'list_connected_apps',
    description: [
      'List the user\'s connected integrations: Google, YouTube, social accounts,',
      'and AI assistants (OpenAI, Anthropic, Gemini). Call when the user asks:',
      '"welche Apps sind verbunden?", "ist mein Google-Konto verknüpft?",',
      '"what apps are connected?", "is Spotify linked?".',
      'AFTER: name each connected app naturally in the user\'s language; if none,',
      'say so and mention Settings → Connected Apps.',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'disconnect_app',
    description: [
      'Disconnect one connected integration (Google, YouTube, Instagram, an AI',
      'assistant, ...). Triggers: "trenne mein Google-Konto", "entferne YouTube",',
      '"disconnect my Google account", "unlink ChatGPT".',
      'TWO-STEP: first call WITHOUT confirm — the tool returns a confirmation',
      'question to relay. Only after the user explicitly says yes, call again',
      'with confirm=true. Never disconnect without that explicit yes.',
      'AFTER (confirmed): confirm it is disconnected and reconnectable in',
      'Settings → Connected Apps.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Which integration to disconnect, e.g. google, youtube, instagram, facebook, tiktok, linkedin, twitter, openai, anthropic, gemini.',
        },
        confirm: {
          type: 'boolean',
          description: 'Pass true ONLY after the user explicitly confirmed the disconnect out loud.',
        },
      },
      required: ['provider'],
    },
  },
];
