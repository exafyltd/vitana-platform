/**
 * VTID-04450: send mail from the member's iCloud address (Apple Mail app in
 * Connected Apps) over iCloud SMTP — smtp.mail.me.com:587, STARTTLS, AUTH
 * PLAIN with the same Apple ID + app-specific password used for IMAP.
 *
 * Dependency-free like apple-dav.ts: the exchange is a handful of commands.
 * The dialog runs over a small SmtpTransport so it can be tested without a
 * network; realTransport() is the only part that opens sockets.
 *
 * iCloud only accepts a sender address that belongs to the account, so the
 * From address is the member's Apple ID. An Apple ID that is not an iCloud
 * address (e.g. a Gmail address) is rejected by Apple; that surfaces as
 * `icloud_sender_rejected`, never as a silent failure.
 */

import * as net from 'net';
import * as tls from 'tls';
import { randomUUID } from 'crypto';
import { AppleAuthError, type AppleCredentials } from './apple-dav';

export const ICLOUD_SMTP_HOST = 'smtp.mail.me.com';
export const ICLOUD_SMTP_PORT = 587;
const TIMEOUT_MS = 20_000;
export const MAX_RECIPIENTS = 20;

export interface SmtpReply {
  code: number;
  text: string;
}

export interface SmtpTransport {
  /** The next complete reply (all continuation lines joined). */
  read(): Promise<SmtpReply>;
  write(data: string): void;
  /** Switch the connection to TLS after a 220 to STARTTLS. */
  startTls(): Promise<void>;
  close(): void;
}

export class SmtpError extends Error {
  constructor(public readonly code: string, public readonly reply?: SmtpReply) {
    super(code);
  }
}

export interface OutgoingMail {
  to: string[];
  subject: string;
  body: string;
}

const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/** Split, trim and validate recipients; throws on anything unusable. */
export function parseRecipients(to: string | string[]): string[] {
  const list = (Array.isArray(to) ? to : String(to ?? '').split(/[,;]/))
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (list.length === 0) throw new SmtpError('no_recipients');
  if (list.length > MAX_RECIPIENTS) throw new SmtpError('too_many_recipients');
  for (const a of list) if (!EMAIL_RE.test(a)) throw new SmtpError('invalid_recipient');
  return Array.from(new Set(list.map((a) => a.toLowerCase())));
}

/** RFC 2047 encode a header value only when it is not plain ASCII. */
export function encodeHeader(v: string): string {
  const clean = v.replace(/[\r\n]+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

/** A plain-text UTF-8 message; the body is base64 so no line ever starts with ".". */
export function buildMessage(from: string, mail: OutgoingMail, now = new Date(), id = randomUUID()): string {
  const domain = from.split('@')[1] || 'icloud.com';
  const body64 = Buffer.from(mail.body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: ${from}`,
    `To: ${mail.to.join(', ')}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${id}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body64,
  ].join('\r\n');
}

async function want(t: SmtpTransport, ok: number[], err: string): Promise<SmtpReply> {
  const r = await t.read();
  if (!ok.includes(r.code)) throw new SmtpError(err, r);
  return r;
}

/**
 * The SMTP dialog. STARTTLS is mandatory — the password is never sent
 * before the connection is encrypted.
 */
export async function smtpSend(t: SmtpTransport, creds: AppleCredentials, mail: OutgoingMail, now = new Date()): Promise<{ accepted: string[] }> {
  const from = creds.appleId.trim().toLowerCase();
  try {
    await want(t, [220], 'smtp_greeting');
    t.write('EHLO vitanaland.com\r\n');
    const ehlo = await want(t, [250], 'smtp_ehlo');
    if (!/STARTTLS/i.test(ehlo.text)) throw new SmtpError('smtp_no_starttls', ehlo);
    t.write('STARTTLS\r\n');
    await want(t, [220], 'smtp_starttls');
    await t.startTls();
    t.write('EHLO vitanaland.com\r\n');
    await want(t, [250], 'smtp_ehlo');
    t.write(`AUTH PLAIN ${Buffer.from(`\u0000${creds.appleId}\u0000${creds.password}`, 'utf8').toString('base64')}\r\n`);
    const auth = await t.read();
    if (auth.code !== 235) throw new AppleAuthError('apple_auth_failed');
    t.write(`MAIL FROM:<${from}>\r\n`);
    await want(t, [250], 'icloud_sender_rejected');
    const accepted: string[] = [];
    for (const rcpt of mail.to) {
      t.write(`RCPT TO:<${rcpt}>\r\n`);
      const r = await t.read();
      if (r.code === 250 || r.code === 251) accepted.push(rcpt);
    }
    if (accepted.length === 0) throw new SmtpError('all_recipients_rejected');
    t.write('DATA\r\n');
    await want(t, [354], 'smtp_data');
    t.write(`${buildMessage(from, { ...mail, to: accepted }, now)}\r\n.\r\n`);
    await want(t, [250], 'smtp_message_rejected');
    t.write('QUIT\r\n');
    return { accepted };
  } finally {
    t.close();
  }
}

/** Real sockets: plain TCP, upgraded in place by STARTTLS. */
export function realTransport(host = ICLOUD_SMTP_HOST, port = ICLOUD_SMTP_PORT): Promise<SmtpTransport> {
  return new Promise((resolve, reject) => {
    let sock: net.Socket = net.connect({ host, port });
    let buf = '';
    const queue: SmtpReply[] = [];
    let waiter: { res: (r: SmtpReply) => void; rej: (e: Error) => void } | null = null;
    let failed: Error | null = null;
    const timer = setTimeout(() => fail(new SmtpError('smtp_timeout')), TIMEOUT_MS);

    function fail(e: Error) {
      failed = e;
      clearTimeout(timer);
      sock.destroy();
      if (waiter) { const w = waiter; waiter = null; w.rej(e); }
    }
    function onData(chunk: Buffer) {
      buf += chunk.toString('utf8');
      let lines: string[] = [];
      let idx: number;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        lines.push(line);
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
          const reply = { code: Number(line.slice(0, 3)), text: lines.map((l) => l.slice(4)).join('\n') };
          lines = [];
          if (waiter) { const w = waiter; waiter = null; w.res(reply); } else queue.push(reply);
        }
      }
      if (lines.length) buf = lines.map((l) => `${l}\r\n`).join('') + buf;
    }
    function attach(s: net.Socket) {
      s.on('data', onData);
      s.on('error', (e) => fail(e));
    }
    attach(sock);
    sock.once('connect', () => resolve({
      read() {
        if (failed) return Promise.reject(failed);
        const next = queue.shift();
        if (next) return Promise.resolve(next);
        return new Promise<SmtpReply>((res, rej) => { waiter = { res, rej }; });
      },
      write(data: string) { sock.write(data); },
      startTls() {
        return new Promise<void>((res, rej) => {
          sock.removeListener('data', onData);
          const secure = tls.connect({ socket: sock, servername: host }, () => res());
          secure.once('error', rej);
          sock = secure;
          attach(secure);
        });
      },
      close() { clearTimeout(timer); sock.end(); },
    }));
    sock.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

/** Send one plain-text message from the member's iCloud address. */
export async function sendAppleMail(
  creds: AppleCredentials,
  mail: { to: string | string[]; subject: string; body: string },
  transport: () => Promise<SmtpTransport> = () => realTransport(),
): Promise<{ accepted: string[] }> {
  const to = parseRecipients(mail.to);
  const subject = String(mail.subject ?? '').trim();
  if (!subject) throw new SmtpError('subject_required');
  return smtpSend(await transport(), creds, { to, subject, body: String(mail.body ?? '') });
}
