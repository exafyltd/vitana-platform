/**
 * VTID-05071: Kiro keeps the thread.
 * - A fresh session gets enough history back that a reply carrying a decision survives
 *   (the incident: replies of 3,040 and 8,711 chars lost their middle under the old 2,000 cap).
 * - The gateway closes an idle session at 45 min (the runner at 50, pinned in its own suite).
 * - An approval card waits 10 min instead of 2.
 * - The session rules point Kiro at the Command Hub symbol index instead of a shell grep.
 */
import {
  clipHistoryMessage, restoredHistoryBlock, kiroLimits, KIRO_SESSION_RULES,
  KIRO_HISTORY_MESSAGE_CHARS, KIRO_HISTORY_HEAD_CHARS, KIRO_HISTORY_TOTAL_CHARS,
} from '../src/services/kiro/kiro-turn';
import { permissionTimeoutMs, KIRO_PERMISSION_TIMEOUT_MS_DEFAULT } from '../src/services/kiro/permission-broker';

describe('VTID-05071: history restore keeps decisions', () => {
  it('caps are 6,000 per message (head 1,500) and 40,000 in total', () => {
    expect(KIRO_HISTORY_MESSAGE_CHARS).toBe(6_000);
    expect(KIRO_HISTORY_HEAD_CHARS).toBe(1_500);
    expect(KIRO_HISTORY_TOTAL_CHARS).toBe(40_000);
  });

  it('a 3,040-char reply comes back whole', () => {
    const reply = 'Plan: ' + 'x'.repeat(3_000) + ' AGREED: 4 tabs';
    expect(reply.length).toBeGreaterThan(3_000);
    expect(clipHistoryMessage(reply)).toBe(reply);
  });

  it('an 8,711-char reply keeps its first 1,500 chars and its end', () => {
    const reply = 'HEAD ' + 'm'.repeat(8_660) + ' DECISION: Chat, Deploy Health, Errors, Decisions';
    expect(reply.length).toBeGreaterThanOrEqual(8_711);
    const c = clipHistoryMessage(reply);
    expect(c.length).toBeLessThanOrEqual(6_000);
    expect(c.slice(0, 1_500)).toBe(reply.slice(0, 1_500));
    expect(c.endsWith('DECISION: Chat, Deploy Health, Errors, Decisions')).toBe(true);
    expect(c).toMatch(/\[\d+ chars omitted\]/);
  });

  it('the whole block stays within 40,000 chars and drops the oldest first', () => {
    const history = Array.from({ length: 12 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `msg-${i} ` + 'z'.repeat(5_000) }));
    const b = restoredHistoryBlock(history)!;
    const body = b.text.split('\n').filter((l) => /^(User|You \(Kiro\)):/.test(l)).join('\n');
    expect(body.length).toBeLessThanOrEqual(40_000);
    expect(b.text).toMatch(/earlier message\(s\) omitted/);
    expect(b.text).toContain('msg-11 ');
    expect(b.text).not.toContain('msg-0 ');
  });

  it('the restored block tells Kiro to continue from an agreed decision', () => {
    const b = restoredHistoryBlock([{ role: 'user', content: 'agreed' }])!;
    expect(b.text).toContain('If the thread already agreed on a decision, continue from it; do not re-ask what was agreed.');
  });
});

describe('VTID-05071: session lifetime and approval timeout', () => {
  it('gateway idle close defaults to 45 min (runner: 50 min, pinned in its own suite); env still overrides', () => {
    expect(kiroLimits({}).idleMs).toBe(45 * 60_000);
    expect(kiroLimits({ KIRO_SESSION_IDLE_MS: '60000' }).idleMs).toBe(60_000);
  });

  it('an approval card waits 10 min by default; env still overrides', () => {
    expect(KIRO_PERMISSION_TIMEOUT_MS_DEFAULT).toBe(600_000);
    expect(permissionTimeoutMs({})).toBe(600_000);
    expect(permissionTimeoutMs({ KIRO_PERMISSION_TIMEOUT_MS: '30000' })).toBe(30_000);
  });
});

describe('VTID-05071: session rules', () => {
  it('point Kiro to the symbol index for app.js and away from shell grep', () => {
    expect(KIRO_SESSION_RULES).toContain('services/gateway/specs/command-hub-symbol-index.json');
    expect(KIRO_SESSION_RULES).toContain('Do not grep app.js in a shell.');
    expect(KIRO_SESSION_RULES).toContain('Prefer the read-only @vitana tools over shell commands');
  });
});
