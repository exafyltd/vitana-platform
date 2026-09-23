/**
 * VTID-04403: Microsoft connector — Outlook Mail and Outlook Calendar over
 * Microsoft Graph (and Outlook Contacts since VTID-04449). Mirrors the Google connector's capability shape so the
 * assistant can say "check my Outlook" exactly the way it checks Gmail.
 *
 * Tokens live in social_connections (provider 'microsoft'), written by the
 * existing /social-accounts OAuth callback and kept fresh by the token
 * refresher. Microsoft rotates refresh tokens; refreshToken() returns the
 * new one and the dispatcher stores it.
 *
 * Env: MICROSOFT_OAUTH_CLIENT_ID, MICROSOFT_OAUTH_CLIENT_SECRET,
 *      MICROSOFT_OAUTH_TENANT (optional, default 'common').
 */

import type { ActionRequest, ActionResult, Connector, ConnectorContext, TokenPair } from '../types';
import { refreshMicrosoftAccessToken } from '../../services/connected-apps/microsoft-oauth';

export const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface GraphResult { ok: boolean; status: number; json: any; errorMessage?: string }

export async function graph(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<GraphResult> {
  const resp = await fetch(path.startsWith('http') ? path : `${GRAPH}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = resp.status === 202 || resp.status === 204 ? null : await resp.json(); } catch { /* non-JSON */ }
  if (!resp.ok) {
    return { ok: false, status: resp.status, json, errorMessage: json?.error?.message ?? resp.statusText ?? `HTTP ${resp.status}` };
  }
  return { ok: true, status: resp.status, json };
}

/** Graph answers 403 with ErrorAccessDenied / Authorization_RequestDenied when a scope is missing. */
function isMissingScope(r: GraphResult): boolean {
  if (r.ok || r.status !== 403) return false;
  const code = String(r.json?.error?.code ?? '').toLowerCase();
  return code.includes('accessdenied') || code.includes('requestdenied');
}

function missingScope(capability: string, appId: string): ActionResult {
  return {
    ok: false,
    error: 'insufficient_scope',
    raw: { capability, reconnect_app: appId, hint: `Turn ${appId} on in Connected Apps.` },
  };
}

/** Busy intervals from Outlook for [from, to). Only start/end/showAs are read. */
export async function listOutlookBusy(
  token: string,
  from: string,
  to: string,
  excludeEventIds: ReadonlySet<string> = new Set(),
): Promise<{ ok: true; busy: Array<{ start_time: string; end_time: string }> } | { ok: false; error: string; status: number }> {
  const busy: Array<{ start_time: string; end_time: string }> = [];
  let url: string | null =
    `${GRAPH}/me/calendarView?startDateTime=${encodeURIComponent(from)}&endDateTime=${encodeURIComponent(to)}` +
    `&$select=start,end,showAs,isCancelled,seriesMasterId&$top=200`;
  let pages = 0;
  while (url && pages < 10) {
    // Prefer: UTC so start/end come back as UTC wall times.
    const r = await graph(token, 'GET', url, undefined, { Prefer: 'outlook.timezone="UTC"' });
    if (!r.ok) return { ok: false, error: r.errorMessage ?? 'graph_error', status: r.status };
    for (const ev of r.json?.value ?? []) {
      if (ev?.isCancelled) continue;
      // VTID-04436: events Vitanaland pushed itself are not outside busy time.
      if (excludeEventIds.has(ev?.id) || (ev?.seriesMasterId && excludeEventIds.has(ev.seriesMasterId))) continue;
      if (ev?.showAs === 'free' || ev?.showAs === 'workingElsewhere') continue;
      const s = asUtcIso(ev?.start?.dateTime);
      const e = asUtcIso(ev?.end?.dateTime);
      if (s && e && e > s) busy.push({ start_time: s, end_time: e });
    }
    url = r.json?.['@odata.nextLink'] ?? null;
    pages += 1;
  }
  return { ok: true, busy };
}

/** Graph returns "2026-09-23T10:00:00.0000000" (no zone) under outlook.timezone="UTC". */
export function asUtcIso(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  const withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const microsoftConnector: Connector = {
  id: 'microsoft',
  category: 'productivity',
  display_name: 'Microsoft',
  auth_type: 'oauth2',
  capabilities: ['email.read', 'email.send', 'calendar.list', 'calendar.create', 'contacts.read'],

  async initialize(): Promise<void> {
    if (!process.env.MICROSOFT_OAUTH_CLIENT_ID || !process.env.MICROSOFT_OAUTH_CLIENT_SECRET) {
      console.warn('[microsoft] MICROSOFT_OAUTH_CLIENT_ID/SECRET not set — connector registered but inactive');
    }
  },

  async refreshToken(refresh_token: string): Promise<TokenPair> {
    const r = await refreshMicrosoftAccessToken(refresh_token);
    if (!r.ok || !r.access_token) throw new Error(`microsoft refresh failed: ${r.error}`);
    return {
      access_token: r.access_token,
      refresh_token: r.refresh_token,
      expires_at: new Date(Date.now() + (r.expires_in ?? 3600) * 1000).toISOString(),
      scopes_granted: r.scopes_granted,
    };
  },

  async performAction(_ctx: ConnectorContext, tokens: TokenPair, action: ActionRequest): Promise<ActionResult> {
    const token = tokens.access_token;
    switch (action.capability) {
      case 'email.read': {
        const limit = Math.max(1, Math.min(25, Number(action.args?.limit ?? 5) || 5));
        const from = typeof action.args?.from === 'string' ? (action.args.from as string).trim() : '';
        const unreadOnly = action.args?.unread_only !== false;
        const filters: string[] = [];
        if (unreadOnly) filters.push('isRead eq false');
        if (from) filters.push(`from/emailAddress/address eq '${from.replace(/'/g, "''")}'`);
        const q = new URLSearchParams({
          $top: String(limit),
          $select: 'id,from,subject,receivedDateTime,bodyPreview,isRead,webLink',
          $orderby: 'receivedDateTime desc',
        });
        if (filters.length) q.set('$filter', filters.join(' and '));
        const r = await graph(token, 'GET', `/me/mailFolders/inbox/messages?${q.toString()}`);
        if (isMissingScope(r)) return missingScope('email.read', 'outlook-mail');
        if (!r.ok) return { ok: false, error: `Outlook mail list failed: ${r.errorMessage}` };
        const messages = (r.json?.value ?? []).map((m: any) => ({
          id: m.id,
          from: m.from?.emailAddress?.name
            ? `${m.from.emailAddress.name} <${m.from.emailAddress.address}>`
            : m.from?.emailAddress?.address ?? '',
          subject: m.subject || '(no subject)',
          date: m.receivedDateTime ?? '',
          snippet: m.bodyPreview ?? '',
          url: m.webLink ?? '',
        }));
        return {
          ok: true,
          raw: {
            action: 'structured_list',
            messages,
            summary: messages.length === 0
              ? (unreadOnly ? 'No unread emails.' : 'No emails matched.')
              : `${messages.length} ${unreadOnly ? 'unread ' : ''}email${messages.length === 1 ? '' : 's'}${from ? ' from ' + from : ''}.`,
          },
        };
      }

      case 'email.send': {
        const to = String(action.args?.to ?? '').trim();
        const subject = String(action.args?.subject ?? '').trim();
        const body = String(action.args?.body ?? '');
        if (!to || !subject) return { ok: false, error: 'email.send: "to" and "subject" are required' };
        const recipients = to.split(/[,;]\s*/).filter(Boolean).map((address) => ({ emailAddress: { address } }));
        const r = await graph(token, 'POST', '/me/sendMail', {
          message: { subject, body: { contentType: 'Text', content: body }, toRecipients: recipients },
          saveToSentItems: true,
        });
        if (isMissingScope(r)) return missingScope('email.send', 'outlook-mail');
        if (!r.ok) return { ok: false, error: `Outlook send failed: ${r.errorMessage}` };
        return { ok: true, raw: { action: 'ack', to, subject, summary: `Email sent to ${to}.` } };
      }

      case 'calendar.list': {
        const daysAhead = Math.max(1, Math.min(60, Number(action.args?.days_ahead ?? 7) || 7));
        const from = new Date().toISOString();
        const to = new Date(Date.now() + daysAhead * 86_400_000).toISOString();
        const q = `startDateTime=${encodeURIComponent(from)}&endDateTime=${encodeURIComponent(to)}` +
          `&$select=id,subject,start,end,location,isAllDay,webLink&$orderby=start/dateTime&$top=20`;
        const r = await graph(token, 'GET', `/me/calendarView?${q}`, undefined, { Prefer: 'outlook.timezone="UTC"' });
        if (isMissingScope(r)) return missingScope('calendar.list', 'outlook-calendar');
        if (!r.ok) return { ok: false, error: `Outlook calendar list failed: ${r.errorMessage}` };
        const events = (r.json?.value ?? []).map((ev: any) => ({
          id: ev.id,
          summary: ev.subject || '(no title)',
          start: asUtcIso(ev.start?.dateTime),
          end: asUtcIso(ev.end?.dateTime),
          location: ev.location?.displayName ?? '',
          all_day: Boolean(ev.isAllDay),
          html_link: ev.webLink ?? '',
        }));
        return {
          ok: true,
          raw: {
            action: 'structured_list',
            events,
            days_ahead: daysAhead,
            summary: events.length === 0
              ? `No events in the next ${daysAhead} day${daysAhead === 1 ? '' : 's'}.`
              : `${events.length} event${events.length === 1 ? '' : 's'} in the next ${daysAhead} day${daysAhead === 1 ? '' : 's'}.`,
          },
        };
      }

      case 'calendar.create': {
        const subject = String(action.args?.title ?? '').trim();
        const start = String(action.args?.start ?? '').trim();
        if (!subject) return { ok: false, error: 'calendar.create: "title" is required' };
        const s = new Date(start);
        if (!start || Number.isNaN(s.getTime())) return { ok: false, error: 'calendar.create: "start" must be a valid RFC3339 time' };
        const endRaw = String(action.args?.end ?? '').trim();
        const e = endRaw ? new Date(endRaw) : new Date(s.getTime() + 3_600_000);
        if (Number.isNaN(e.getTime())) return { ok: false, error: 'calendar.create: "end" is not a valid time' };
        const attendees = Array.isArray(action.args?.attendees) ? (action.args.attendees as string[]) : [];
        const bodyText = typeof action.args?.description === 'string' ? (action.args.description as string) : '';
        const r = await graph(token, 'POST', '/me/events', {
          subject,
          start: { dateTime: s.toISOString().replace('Z', ''), timeZone: 'UTC' },
          end: { dateTime: e.toISOString().replace('Z', ''), timeZone: 'UTC' },
          ...(bodyText ? { body: { contentType: 'Text', content: bodyText } } : {}),
          ...(attendees.length
            ? { attendees: attendees.map((address) => ({ emailAddress: { address }, type: 'required' })) }
            : {}),
        });
        if (isMissingScope(r)) return missingScope('calendar.create', 'outlook-calendar');
        if (!r.ok) return { ok: false, error: `Outlook event create failed: ${r.errorMessage}` };
        return {
          ok: true,
          external_id: r.json?.id,
          url: r.json?.webLink,
          raw: { action: 'ack', summary: subject, start: s.toISOString(), end: e.toISOString(), html_link: r.json?.webLink },
        };
      }

      // VTID-04449: Outlook address book, optional name/email/phone filter.
      case 'contacts.read': {
        const q = typeof action.args?.query === 'string' ? (action.args.query as string).trim().toLowerCase() : '';
        const limit = Math.max(1, Math.min(200, Number(action.args?.limit ?? 50) || 50));
        const r = await graph(
          token,
          'GET',
          `/me/contacts?$select=displayName,givenName,surname,emailAddresses,mobilePhone,homePhones,businessPhones&$top=${q ? 500 : limit}`,
        );
        if (isMissingScope(r)) return missingScope('contacts.read', 'outlook-contacts');
        if (!r.ok) return { ok: false, error: `Outlook contacts list failed: ${r.errorMessage}` };
        const all = (r.json?.value ?? []).map((c: any) => ({
          name: c.displayName || [c.givenName, c.surname].filter(Boolean).join(' '),
          emails: (c.emailAddresses ?? []).map((e: any) => e?.address).filter(Boolean) as string[],
          phones: [c.mobilePhone, ...(c.homePhones ?? []), ...(c.businessPhones ?? [])].filter(Boolean) as string[],
        })).filter((c: any) => c.name || c.emails.length || c.phones.length);
        const filtered = q
          ? all.filter((c: any) =>
              String(c.name ?? '').toLowerCase().includes(q) ||
              c.emails.some((e: string) => e.toLowerCase().includes(q)) ||
              c.phones.some((p: string) => p.toLowerCase().includes(q)))
          : all;
        return {
          ok: true,
          raw: {
            action: 'structured_list',
            contacts: filtered.slice(0, limit),
            total: filtered.length,
            summary: `${filtered.length} contact${filtered.length === 1 ? '' : 's'}${q ? ` matching "${q}"` : ''}.`,
          },
        };
      }

      default:
        return { ok: false, error: `Unknown capability ${action.capability}` };
    }
  },
};

export default microsoftConnector;
