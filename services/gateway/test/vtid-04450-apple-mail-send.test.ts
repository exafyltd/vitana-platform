/**
 * VTID-04450 — Apple Mail can send, over iCloud SMTP with the member's
 * app-specific password. Pins the SMTP dialog against a scripted server:
 * STARTTLS before the password, AUTH PLAIN, the From is the Apple ID,
 * rejected recipients are dropped, a rejected sender and a bad password are
 * named, and the message is plain UTF-8 text in base64.
 */
import type { SmtpReply, SmtpTransport } from '../src/services/connected-apps/apple-smtp';

const smtp = jest.requireActual('../src/services/connected-apps/apple-smtp');
const dav = jest.requireActual('../src/services/connected-apps/apple-dav');

const CREDS = { appleId: 'Ana@iCloud.com', password: 'abcd-efgh-ijkl-mnop' };

/** A server that answers each client line from a script keyed by the command. */
function scriptedServer(over: Partial<Record<string, SmtpReply>> = {}, rcpt: (addr: string) => SmtpReply = () => ({ code: 250, text: 'OK' })) {
  const writes: string[] = [];
  const events: string[] = [];
  const pending: SmtpReply[] = [{ code: 220, text: 'smtp.mail.me.com ESMTP' }];
  let tlsOn = false;
  const reply = (cmd: string): SmtpReply | null => {
    const verb = cmd.split(/[\s:]/)[0].toUpperCase();
    if (over[verb]) return over[verb]!;
    switch (verb) {
      case 'EHLO': return { code: 250, text: tlsOn ? 'smtp.mail.me.com\nAUTH PLAIN LOGIN' : 'smtp.mail.me.com\nSTARTTLS\nSIZE 28311552' };
      case 'STARTTLS': return { code: 220, text: 'Ready to start TLS' };
      case 'AUTH': return { code: 235, text: 'Authentication successful' };
      case 'MAIL': return { code: 250, text: 'OK' };
      case 'RCPT': return rcpt(cmd.match(/<([^>]+)>/)![1]);
      case 'DATA': return { code: 354, text: 'go ahead' };
      case 'QUIT': return { code: 221, text: 'bye' };
      default: return null;
    }
  };
  let inData = false;
  const t: SmtpTransport = {
    async read() {
      const r = pending.shift();
      if (!r) throw new Error('read with nothing pending');
      return r;
    },
    write(data: string) {
      writes.push(data);
      if (inData) {
        inData = false;
        pending.push(over.MESSAGE ?? { code: 250, text: 'queued' });
        return;
      }
      events.push(`${tlsOn ? 'tls' : 'plain'}:${data.split(/\s/)[0]}`);
      const r = reply(data.trim());
      if (data.startsWith('DATA')) inData = true;
      if (r) pending.push(r);
    },
    async startTls() { tlsOn = true; events.push('starttls'); },
    close() { events.push('close'); },
  };
  return { t, writes, events };
}

const NOW = new Date('2026-09-23T20:00:00Z');

describe('smtpSend', () => {
  it('STARTTLS comes before the password; AUTH PLAIN; From is the Apple ID', async () => {
    const { t, writes, events } = scriptedServer();
    const r = await smtp.smtpSend(t, CREDS, { to: ['clara@example.com'], subject: 'Hallo', body: 'Bis morgen' }, NOW);
    expect(r).toEqual({ accepted: ['clara@example.com'] });
    expect(events.indexOf('starttls')).toBeLessThan(events.indexOf('tls:AUTH'));
    expect(events).not.toContain('plain:AUTH');
    const auth = writes.find((w) => w.startsWith('AUTH PLAIN '))!;
    expect(Buffer.from(auth.slice(11).trim(), 'base64').toString('utf8')).toBe('\u0000Ana@iCloud.com\u0000abcd-efgh-ijkl-mnop');
    expect(writes).toContain('MAIL FROM:<ana@icloud.com>\r\n');
    expect(writes).toContain('RCPT TO:<clara@example.com>\r\n');
    expect(events[events.length - 1]).toBe('close');
  });

  it('refuses to authenticate on a server without STARTTLS', async () => {
    const { t, writes } = scriptedServer({ EHLO: { code: 250, text: 'smtp.example\nAUTH PLAIN' } });
    await expect(smtp.smtpSend(t, CREDS, { to: ['a@b.co'], subject: 's', body: 'b' })).rejects.toThrow('smtp_no_starttls');
    expect(writes.some((w) => w.startsWith('AUTH'))).toBe(false);
  });

  it('a rejected app-specific password is an AppleAuthError', async () => {
    const { t } = scriptedServer({ AUTH: { code: 535, text: 'Authentication failed' } });
    await expect(smtp.smtpSend(t, CREDS, { to: ['a@b.co'], subject: 's', body: 'b' })).rejects.toBeInstanceOf(dav.AppleAuthError);
  });

  it('a non-iCloud sender is named, not swallowed', async () => {
    const { t } = scriptedServer({ MAIL: { code: 550, text: 'sender not allowed' } });
    await expect(smtp.smtpSend(t, { ...CREDS, appleId: 'ana@gmail.com' }, { to: ['a@b.co'], subject: 's', body: 'b' }))
      .rejects.toMatchObject({ code: 'icloud_sender_rejected' });
  });

  it('rejected recipients are dropped; all rejected fails before DATA', async () => {
    const some = scriptedServer({}, (a) => (a === 'bad@x.co' ? { code: 550, text: 'no such user' } : { code: 250, text: 'OK' }));
    const r = await smtp.smtpSend(some.t, CREDS, { to: ['bad@x.co', 'ok@x.co'], subject: 's', body: 'b' }, NOW);
    expect(r.accepted).toEqual(['ok@x.co']);
    const msg = some.writes.find((w) => w.includes('Content-Transfer-Encoding'))!;
    expect(msg).toContain('To: ok@x.co\r\n');

    const none = scriptedServer({}, () => ({ code: 550, text: 'no' }));
    await expect(smtp.smtpSend(none.t, CREDS, { to: ['bad@x.co'], subject: 's', body: 'b' })).rejects.toMatchObject({ code: 'all_recipients_rejected' });
    expect(none.writes).not.toContain('DATA\r\n');
  });
});

describe('message', () => {
  it('is UTF-8 text in base64, subject encoded only when needed, ends the DATA with a lone dot', async () => {
    const { t, writes } = scriptedServer();
    await smtp.smtpSend(t, CREDS, { to: ['m@x.co'], subject: 'Grüße aus Beograd', body: 'Ćao!\n.\nDo sutra' }, NOW);
    const data = writes.find((w) => w.includes('MIME-Version'))!;
    expect(data).toContain('Subject: =?UTF-8?B?' + Buffer.from('Grüße aus Beograd').toString('base64') + '?=');
    expect(data).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(data.endsWith('\r\n.\r\n')).toBe(true);
    const b64 = data.split('\r\n\r\n')[1].replace(/\r\n\.\r\n$/, '').replace(/\r\n/g, '');
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('Ćao!\r\n.\r\nDo sutra');
    expect(smtp.encodeHeader('Plain subject')).toBe('Plain subject');
    expect(smtp.encodeHeader('line\r\nBcc: evil@x.co')).toBe('line Bcc: evil@x.co');
  });
});

describe('parseRecipients', () => {
  it('splits, de-duplicates, validates and caps', () => {
    expect(smtp.parseRecipients('A@x.co; b@y.org, a@x.co')).toEqual(['a@x.co', 'b@y.org']);
    expect(() => smtp.parseRecipients('')).toThrow('no_recipients');
    expect(() => smtp.parseRecipients('not-an-address')).toThrow('invalid_recipient');
    expect(() => smtp.parseRecipients('x@y.co\r\nRCPT TO:<z@z.co>')).toThrow('invalid_recipient');
    expect(() => smtp.parseRecipients(Array.from({ length: 21 }, (_, i) => `u${i}@x.co`))).toThrow('too_many_recipients');
  });
});

describe('Apple connector email.send', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../src/services/connected-apps/apple-store');
    jest.dontMock('../src/services/connected-apps/apple-smtp');
  });

  function load(send: jest.Mock) {
    jest.resetModules();
    jest.doMock('../src/services/connected-apps/apple-store', () => ({
      loadAppleCredentials: jest.fn(async () => ({ credentials: CREDS, caldavHome: null, carddavHome: null })),
    }));
    jest.doMock('../src/services/connected-apps/apple-smtp', () => {
      const real = jest.requireActual('../src/services/connected-apps/apple-smtp');
      return { ...real, sendAppleMail: send };
    });
    return require('../src/connectors/productivity/apple').default;
  }

  it('is offered, and sends through iCloud SMTP', async () => {
    const send = jest.fn(async () => ({ accepted: ['clara@example.com'] }));
    const apple = load(send);
    expect(apple.capabilities).toContain('email.send');
    const r = await apple.performAction({ user_id: 'u1' }, {}, { capability: 'email.send', args: { to: 'clara@example.com', subject: 'Hi', body: 'x' } });
    expect(r).toMatchObject({ ok: true, raw: { action: 'ack', to: 'clara@example.com' } });
    expect(send).toHaveBeenCalledWith(CREDS, { to: 'clara@example.com', subject: 'Hi', body: 'x' });
  });

  it('needs to and subject', async () => {
    const apple = load(jest.fn());
    const r = await apple.performAction({ user_id: 'u1' }, {}, { capability: 'email.send', args: { to: 'a@b.co' } });
    expect(r.ok).toBe(false);
  });

  it('a non-iCloud sender comes back with a hint to fix it', async () => {
    const send = jest.fn();
    const apple = load(send);
    // The class the connector checks against is the one in its own module registry.
    const { SmtpError } = require('../src/services/connected-apps/apple-smtp');
    send.mockImplementation(async () => { throw new SmtpError('icloud_sender_rejected'); });
    const r = await apple.performAction({ user_id: 'u1' }, {}, { capability: 'email.send', args: { to: 'a@b.co', subject: 's', body: 'b' } });
    expect(r).toMatchObject({ ok: false, error: 'icloud_sender_rejected', raw: { reconnect_app: 'apple-mail' } });
  });

  it('the catalogue lets Apple Mail serve email.send', () => {
    const cat = jest.requireActual('../src/services/connected-apps/catalogue');
    expect(cat.getConnectedApp('apple-mail').capabilities).toEqual(['email.read', 'email.send']);
  });
});
