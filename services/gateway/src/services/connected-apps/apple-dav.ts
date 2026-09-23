/**
 * VTID-04404: iCloud over the open protocols Apple supports for third-party
 * clients — CalDAV (calendar), CardDAV (contacts), IMAP (mail) — signed in
 * with the member's Apple ID and an app-specific password
 * (appleid.apple.com → Sign-In and Security → App-Specific Passwords).
 *
 * Deliberately dependency-free: the DAV responses are small multistatus
 * documents and the IMAP exchange is four commands, so a namespace-agnostic
 * extractor and a TLS socket are enough, and the gateway lockfiles stay
 * untouched. Everything here is read-only against the member's account.
 */

import * as tls from 'tls';

export const ICLOUD_CALDAV = 'https://caldav.icloud.com/';
export const ICLOUD_CARDDAV = 'https://contacts.icloud.com/';
export const ICLOUD_IMAP_HOST = 'imap.mail.me.com';
export const ICLOUD_IMAP_PORT = 993;
const TIMEOUT_MS = 15_000;

export interface AppleCredentials {
  appleId: string;
  password: string;
}

export class AppleAuthError extends Error {}

// ---------------------------------------------------------------------------
// XML helpers (namespace-agnostic, enough for DAV multistatus)
// ---------------------------------------------------------------------------

export function xmlUnescape(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/** All inner texts of <prefix:tag>…</prefix:tag> (any prefix, or none). */
export function xmlTexts(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${tag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

export function xmlFirst(xml: string, tag: string): string | null {
  return xmlTexts(xml, tag)[0] ?? null;
}

/** Whether an element (self-closing or not) appears in a fragment. */
export function xmlHas(xml: string, tag: string): boolean {
  return new RegExp(`<(?:[A-Za-z0-9_-]+:)?${tag}[\\s/>]`).test(xml);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function basic(c: AppleCredentials): string {
  return `Basic ${Buffer.from(`${c.appleId}:${c.password}`).toString('base64')}`;
}

async function dav(
  c: AppleCredentials,
  method: 'PROPFIND' | 'REPORT',
  url: string,
  body: string,
  depth: '0' | '1',
): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method,
      headers: {
        Authorization: basic(c),
        Depth: depth,
        'Content-Type': 'application/xml; charset=utf-8',
        'User-Agent': 'Vitanaland/1.0',
      },
      body,
      signal: ctl.signal,
      redirect: 'follow',
    });
    if (r.status === 401 || r.status === 403) throw new AppleAuthError('apple_auth_failed');
    if (r.status !== 207 && !r.ok) throw new Error(`dav ${method} ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

/** Resolve an href against the server it came from. */
export function absolute(base: string, href: string): string {
  return new URL(xmlUnescape(href.trim()), base).toString();
}

const PRINCIPAL_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';

async function principal(c: AppleCredentials, root: string): Promise<string> {
  const xml = await dav(c, 'PROPFIND', root, PRINCIPAL_BODY, '0');
  const cup = xmlFirst(xml, 'current-user-principal');
  const href = cup ? xmlFirst(cup, 'href') : null;
  if (!href) throw new Error('dav_no_principal');
  return absolute(root, href);
}

async function homeSet(c: AppleCredentials, principalUrl: string, kind: 'calendar' | 'addressbook'): Promise<string> {
  const ns = kind === 'calendar' ? 'urn:ietf:params:xml:ns:caldav' : 'urn:ietf:params:xml:ns:carddav';
  const prop = kind === 'calendar' ? 'calendar-home-set' : 'addressbook-home-set';
  const body = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:x="${ns}"><d:prop><x:${prop}/></d:prop></d:propfind>`;
  const xml = await dav(c, 'PROPFIND', principalUrl, body, '0');
  const set = xmlFirst(xml, prop);
  const href = set ? xmlFirst(set, 'href') : null;
  if (!href) throw new Error(`dav_no_${prop}`);
  return absolute(principalUrl, href);
}

export interface AppleDiscovery {
  caldavHome: string;
  carddavHome: string;
}

/** Sign in and find the calendar + contacts homes. Throws AppleAuthError on a bad password. */
export async function discoverApple(c: AppleCredentials): Promise<AppleDiscovery> {
  const calPrincipal = await principal(c, ICLOUD_CALDAV);
  const caldavHome = await homeSet(c, calPrincipal, 'calendar');
  const cardPrincipal = await principal(c, ICLOUD_CARDDAV);
  const carddavHome = await homeSet(c, cardPrincipal, 'addressbook');
  return { caldavHome, carddavHome };
}

/** Split a multistatus body into its <response> blocks. */
export function responses(xml: string): string[] {
  return xmlTexts(xml, 'response');
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export async function listCalendars(c: AppleCredentials, home: string): Promise<string[]> {
  const body =
    '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
    '<d:prop><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>';
  const xml = await dav(c, 'PROPFIND', home, body, '1');
  const out: string[] = [];
  for (const r of responses(xml)) {
    const rt = xmlFirst(r, 'resourcetype') ?? '';
    if (!xmlHas(rt, 'calendar')) continue;
    const comps = xmlFirst(r, 'supported-calendar-component-set');
    if (comps && !/name="VEVENT"/i.test(comps)) continue;
    const href = xmlFirst(r, 'href');
    if (href) out.push(absolute(home, href));
  }
  return out;
}

function caldavStamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export interface IcsEvent {
  uid: string;
  summary: string;
  start: string | null;
  end: string | null;
  allDay: boolean;
  transparent: boolean;
  cancelled: boolean;
}

/** Unfold RFC 5545 content lines. */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

/**
 * A DTSTART/DTEND value as UTC ISO. Floating and TZID-local times are read
 * as UTC — the server-side expand we request returns UTC for recurring
 * instances, and a busy block an hour off for a floating event is the
 * accepted cost of not shipping a timezone database here.
 */
export function icsTime(line: string): { iso: string | null; allDay: boolean } {
  const idx = line.indexOf(':');
  if (idx < 0) return { iso: null, allDay: false };
  const params = line.slice(0, idx);
  const v = line.slice(idx + 1).trim();
  const allDay = /VALUE=DATE(?!-)/i.test(params) || /^\d{8}$/.test(v);
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/);
  if (!m) return { iso: null, allDay };
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  const t = new Date(iso);
  return { iso: Number.isNaN(t.getTime()) ? null : t.toISOString(), allDay };
}

function icsText(v: string): string {
  return v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
}

export function parseIcsEvents(ics: string): IcsEvent[] {
  const out: IcsEvent[] = [];
  let cur: IcsEvent | null = null;
  let duration: string | null = null;
  for (const line of unfold(ics)) {
    if (line === 'BEGIN:VEVENT') {
      cur = { uid: '', summary: '', start: null, end: null, allDay: false, transparent: false, cancelled: false };
      duration = null;
      continue;
    }
    if (!cur) continue;
    if (line === 'END:VEVENT') {
      if (cur.start && !cur.end) {
        const base = new Date(cur.start).getTime();
        cur.end = new Date(base + (duration ? parseDuration(duration) : cur.allDay ? 86_400_000 : 0)).toISOString();
      }
      out.push(cur);
      cur = null;
      continue;
    }
    const name = line.split(/[;:]/, 1)[0].toUpperCase();
    const value = line.slice(line.indexOf(':') + 1);
    if (name === 'UID') cur.uid = value.trim();
    else if (name === 'SUMMARY') cur.summary = icsText(value);
    else if (name === 'DTSTART') { const t = icsTime(line); cur.start = t.iso; cur.allDay = t.allDay; }
    else if (name === 'DTEND') cur.end = icsTime(line).iso;
    else if (name === 'DURATION') duration = value.trim();
    else if (name === 'TRANSP') cur.transparent = value.trim().toUpperCase() === 'TRANSPARENT';
    else if (name === 'STATUS') cur.cancelled = value.trim().toUpperCase() === 'CANCELLED';
  }
  return out;
}

/** P1DT2H30M → ms (weeks, days, hours, minutes, seconds). */
export function parseDuration(d: string): number {
  const m = d.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const [, sign, w, dd, h, mi, s] = m;
  const ms = ((+(w || 0) * 7 + +(dd || 0)) * 24 * 3600 + +(h || 0) * 3600 + +(mi || 0) * 60 + +(s || 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

/** Events in [from, to) across every calendar, recurrences expanded by the server. */
export async function listAppleEvents(
  c: AppleCredentials,
  home: string,
  from: string,
  to: string,
): Promise<IcsEvent[]> {
  const calendars = await listCalendars(c, home);
  const start = caldavStamp(from);
  const end = caldavStamp(to);
  const body =
    '<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
    `<d:prop><c:calendar-data><c:expand start="${start}" end="${end}"/></c:calendar-data></d:prop>` +
    `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${start}" end="${end}"/>` +
    '</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>';
  const events: IcsEvent[] = [];
  for (const cal of calendars.slice(0, 20)) {
    const xml = await dav(c, 'REPORT', cal, body, '1');
    for (const r of responses(xml)) {
      const data = xmlFirst(r, 'calendar-data');
      if (data) events.push(...parseIcsEvents(xmlUnescape(data)));
    }
  }
  return events;
}

/** Busy intervals only — never titles. Transparent and cancelled events are free. */
export function busyFromEvents(events: IcsEvent[]): Array<{ start_time: string; end_time: string }> {
  return events
    .filter((e) => !e.transparent && !e.cancelled && !e.allDay && e.start && e.end && e.end > e.start)
    .map((e) => ({ start_time: e.start as string, end_time: e.end as string }));
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export interface VCardContact {
  uid: string;
  name: string;
  emails: string[];
  phones: string[];
}

export function parseVCards(text: string): VCardContact[] {
  const out: VCardContact[] = [];
  let cur: VCardContact | null = null;
  let n = '';
  for (const line of unfold(text)) {
    if (/^BEGIN:VCARD$/i.test(line)) { cur = { uid: '', name: '', emails: [], phones: [] }; n = ''; continue; }
    if (!cur) continue;
    if (/^END:VCARD$/i.test(line)) {
      if (!cur.name && n) {
        const [family = '', given = ''] = n.split(';');
        cur.name = [given, family].filter(Boolean).join(' ').trim();
      }
      out.push(cur);
      cur = null;
      continue;
    }
    // Strip group prefixes like "item1.EMAIL".
    const nameRaw = line.split(/[;:]/, 1)[0].replace(/^[^.]+\./, '').toUpperCase();
    const value = line.slice(line.indexOf(':') + 1).trim();
    if (nameRaw === 'UID') cur.uid = value;
    else if (nameRaw === 'FN') cur.name = icsText(value);
    else if (nameRaw === 'N') n = value;
    else if (nameRaw === 'EMAIL' && value) cur.emails.push(value.toLowerCase());
    else if (nameRaw === 'TEL' && value) cur.phones.push(value.replace(/^tel:/i, ''));
  }
  return out;
}

export async function listAppleContacts(c: AppleCredentials, home: string): Promise<VCardContact[]> {
  const list = await dav(
    c,
    'PROPFIND',
    home,
    '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    '1',
  );
  const books: string[] = [];
  for (const r of responses(list)) {
    if (!xmlHas(xmlFirst(r, 'resourcetype') ?? '', 'addressbook')) continue;
    const href = xmlFirst(r, 'href');
    if (href) books.push(absolute(home, href));
  }
  const body =
    '<?xml version="1.0" encoding="utf-8"?><card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
    '<d:prop><card:address-data/></d:prop></card:addressbook-query>';
  const out: VCardContact[] = [];
  for (const book of books.slice(0, 5)) {
    const xml = await dav(c, 'REPORT', book, body, '1');
    for (const r of responses(xml)) {
      const data = xmlFirst(r, 'address-data');
      if (data) out.push(...parseVCards(xmlUnescape(data)));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mail (IMAP, read-only: newest message headers)
// ---------------------------------------------------------------------------

export interface MailHeader {
  uid: number;
  from: string;
  subject: string;
  date: string;
}

/** RFC 2047 encoded words (=?utf-8?B?…?= / =?utf-8?Q?…?=). */
export function decodeMimeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
    try {
      const buf = enc.toUpperCase() === 'B'
        ? Buffer.from(text, 'base64')
        : Buffer.from(
            text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16))),
            'binary',
          );
      const cs = charset.toLowerCase();
      return buf.toString(cs === 'iso-8859-1' || cs === 'latin1' ? 'latin1' : 'utf8');
    } catch {
      return text;
    }
  }).replace(/\?=\s+=\?/g, '?==?');
}

/** Parse "From:/Subject:/Date:" header blocks out of a FETCH response. */
export function parseHeaderBlocks(raw: string): MailHeader[] {
  const out: MailHeader[] = [];
  const re = /\* \d+ FETCH \(UID (\d+)[^{]*\{(\d+)\}\r\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const uid = Number(m[1]);
    const len = Number(m[2]);
    const block = Buffer.from(raw.slice(re.lastIndex), 'binary').subarray(0, len).toString('utf8');
    const unfolded = block.replace(/\r\n[ \t]+/g, ' ');
    const h = (name: string) => {
      const mm = unfolded.match(new RegExp(`^${name}:\\s*(.*)$`, 'im'));
      return mm ? decodeMimeWords(mm[1].trim()) : '';
    };
    out.push({ uid, from: h('From'), subject: h('Subject') || '(no subject)', date: h('Date') });
  }
  return out;
}

/** Quote an IMAP string argument. */
export function imapQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

type Conn = { send: (cmd: string) => Promise<string>; close: () => void };

function imapConnect(host: string, port: number): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host });
    let buf = '';
    let waiter: { tag: string; resolve: (s: string) => void; reject: (e: Error) => void } | null = null;
    let greeted = false;
    let n = 0;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('imap_timeout')); }, TIMEOUT_MS);
    socket.setEncoding('binary');
    socket.on('error', (e) => { clearTimeout(timer); waiter ? waiter.reject(e) : reject(e); });
    socket.on('data', (chunk: string) => {
      buf += chunk;
      if (!greeted) {
        if (!buf.includes('\r\n')) return;
        greeted = true;
        buf = '';
        resolve({
          send(cmd: string) {
            return new Promise<string>((res, rej) => {
              n += 1;
              const tag = `V${n}`;
              waiter = { tag, resolve: res, reject: rej };
              socket.write(`${tag} ${cmd}\r\n`);
            });
          },
          close() { clearTimeout(timer); try { socket.write('Z LOGOUT\r\n'); } catch { /* closing */ } socket.end(); },
        });
        return;
      }
      if (!waiter) return;
      const done = new RegExp(`(^|\\r\\n)${waiter.tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n`).exec(buf);
      if (!done) return;
      const w = waiter;
      waiter = null;
      const out = buf;
      buf = '';
      if (done[2] === 'OK') w.resolve(out);
      else w.reject(new Error(done[0].trim().toLowerCase().includes('authentication') || done[0].includes('LOGIN') ? 'imap_auth_failed' : `imap_${done[2].toLowerCase()}`));
    });
  });
}

/** Newest `limit` (unread, when asked) INBOX headers. Never marks anything read. */
export async function listAppleMail(
  c: AppleCredentials,
  opts: { limit: number; unreadOnly: boolean },
  host = ICLOUD_IMAP_HOST,
  port = ICLOUD_IMAP_PORT,
): Promise<MailHeader[]> {
  const conn = await imapConnect(host, port);
  try {
    try {
      await conn.send(`LOGIN ${imapQuote(c.appleId)} ${imapQuote(c.password)}`);
    } catch {
      throw new AppleAuthError('apple_auth_failed');
    }
    await conn.send('EXAMINE INBOX');
    const search = await conn.send(`UID SEARCH ${opts.unreadOnly ? 'UNSEEN' : 'ALL'}`);
    const line = search.split('\r\n').find((l) => l.startsWith('* SEARCH')) ?? '';
    const uids = line.replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean).map(Number)
      .filter((x) => Number.isFinite(x));
    const pick = uids.slice(-Math.max(1, Math.min(25, opts.limit)));
    if (pick.length === 0) return [];
    const fetched = await conn.send(`UID FETCH ${pick.join(',')} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`);
    return parseHeaderBlocks(fetched).sort((a, b) => b.uid - a.uid);
  } finally {
    conn.close();
  }
}
