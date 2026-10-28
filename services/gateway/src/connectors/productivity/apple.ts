/**
 * VTID-04404: Apple iCloud connector — Apple Mail (IMAP read, and SMTP send
 * since VTID-04450), Apple Calendar (CalDAV, read) and iPhone Contacts
 * (CardDAV, read).
 *
 * Apple offers no OAuth for these, so the member signs in once with an
 * Apple ID and an app-specific password. It is stored encrypted in
 * apple_account_credentials and loaded here per call (auth_type
 * 'app_password' tells the dispatcher not to look in social_connections).
 * Sending mail (VTID-04450) goes through the same email.send capability as
 * Gmail and Outlook, from the member's own iCloud address; the Apple sign-in
 * screen says so. Writing events is limited to the one "Vitanaland" calendar
 * the calendar push manages (VTID-04436).
 */

import type { ActionRequest, ActionResult, Connector, ConnectorContext, TokenPair } from '../types';
import { loadAppleCredentials } from '../../services/connected-apps/apple-store';
import { AppleAuthError, listAppleContacts, listAppleEvents, listAppleMail } from '../../services/connected-apps/apple-dav';
import { SmtpError, sendAppleMail } from '../../services/connected-apps/apple-smtp';

function notConnected(capability: string, appId: string): ActionResult {
  return { ok: false, error: 'not_connected', raw: { capability, reconnect_app: appId, hint: `Turn ${appId} on in Connected Apps.` } };
}

const appleConnector: Connector = {
  id: 'apple',
  category: 'productivity',
  display_name: 'Apple iCloud',
  auth_type: 'app_password',
  capabilities: ['email.read', 'email.send', 'calendar.list', 'contacts.read'],

  async performAction(ctx: ConnectorContext, _tokens: TokenPair, action: ActionRequest): Promise<ActionResult> {
    const creds = await loadAppleCredentials(ctx.user_id);
    const appFor: Record<string, string> = {
      'email.read': 'apple-mail',
      'email.send': 'apple-mail',
      'calendar.list': 'apple-calendar',
      'contacts.read': 'iphone-contacts',
    };
    if (!creds) return notConnected(action.capability, appFor[action.capability] ?? 'apple');
    try {
      switch (action.capability) {
        case 'email.read': {
          const limit = Math.max(1, Math.min(25, Number(action.args?.limit ?? 5) || 5));
          const unreadOnly = action.args?.unread_only !== false;
          const from = typeof action.args?.from === 'string' ? (action.args.from as string).trim().toLowerCase() : '';
          let messages = await listAppleMail(creds.credentials, { limit: from ? 25 : limit, unreadOnly });
          if (from) messages = messages.filter((m) => m.from.toLowerCase().includes(from)).slice(0, limit);
          return {
            ok: true,
            raw: {
              action: 'structured_list',
              messages,
              summary: messages.length === 0
                ? (unreadOnly ? 'No unread emails.' : 'No emails matched.')
                : `${messages.length} ${unreadOnly ? 'unread ' : ''}email${messages.length === 1 ? '' : 's'}.`,
            },
          };
        }
        case 'email.send': {
          const to = action.args?.to as string | string[] | undefined;
          const subject = String(action.args?.subject ?? '');
          const body = String(action.args?.body ?? '');
          if (!to || !subject.trim()) return { ok: false, error: 'email.send: "to" and "subject" are required' };
          const r = await sendAppleMail(creds.credentials, { to, subject, body });
          const list = r.accepted.join(', ');
          return { ok: true, raw: { action: 'ack', to: list, subject, summary: `Email sent to ${list}.` } };
        }
        case 'calendar.list': {
          if (!creds.caldavHome) return notConnected('calendar.list', 'apple-calendar');
          const daysAhead = Math.max(1, Math.min(60, Number(action.args?.days_ahead ?? 7) || 7));
          const from = new Date().toISOString();
          const to = new Date(Date.now() + daysAhead * 86_400_000).toISOString();
          const events = (await listAppleEvents(creds.credentials, creds.caldavHome, from, to))
            .filter((e) => !e.cancelled && e.start)
            .sort((a, b) => String(a.start).localeCompare(String(b.start)))
            .slice(0, 20)
            .map((e) => ({ id: e.uid, summary: e.summary || '(no title)', start: e.start, end: e.end, all_day: e.allDay }));
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
        case 'contacts.read': {
          if (!creds.carddavHome) return notConnected('contacts.read', 'iphone-contacts');
          const q = typeof action.args?.query === 'string' ? (action.args.query as string).trim().toLowerCase() : '';
          const limit = Math.max(1, Math.min(200, Number(action.args?.limit ?? 50) || 50));
          const all = await listAppleContacts(creds.credentials, creds.carddavHome);
          const filtered = q
            ? all.filter((c) => c.name.toLowerCase().includes(q) || c.emails.some((e) => e.includes(q)) || c.phones.some((p) => p.includes(q)))
            : all;
          return {
            ok: true,
            raw: {
              action: 'structured_list',
              contacts: filtered.slice(0, limit).map((c) => ({ name: c.name, emails: c.emails, phones: c.phones })),
              total: filtered.length,
              summary: `${filtered.length} contact${filtered.length === 1 ? '' : 's'}${q ? ` matching "${q}"` : ''}.`,
            },
          };
        }
        default:
          return { ok: false, error: `Unknown capability ${action.capability}` };
      }
    } catch (err: unknown) {
      if (err instanceof SmtpError) {
        const hint = err.code === 'icloud_sender_rejected'
          ? 'iCloud only sends from an iCloud address. Sign in to Apple Mail in Connected Apps with your @icloud.com address.'
          : undefined;
        return { ok: false, error: err.code, ...(hint ? { raw: { hint, reconnect_app: 'apple-mail' } } : {}) };
      }
      if (err instanceof AppleAuthError) {
        return { ok: false, error: 'apple_auth_failed', raw: { hint: 'The app-specific password was revoked. Turn the Apple app off and on again in Connected Apps.' } };
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

export default appleConnector;
