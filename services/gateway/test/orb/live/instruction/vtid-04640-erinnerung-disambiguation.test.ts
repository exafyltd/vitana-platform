/**
 * VTID-04640 — German "Erinnerung"/"erinnern" names both a reminder and a
 * memory. A member asking Vitana to remember something ("Ich möchte, dass du
 * dich erinnerst") got a reminder instead. The TOOLS section must tell the
 * model which German phrasings mean which tool.
 */
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(
  path.join(__dirname, '../../../../src/orb/live/instruction/live-system-instruction.ts'),
  'utf8',
);

describe('VTID-04640 Erinnerung disambiguation', () => {
  const line = src.split('\n').find((l) => l.includes('VTID-04640')) ?? '';

  it('lives on the set_reminder line in the TOOLS section', () => {
    const idx = src.indexOf('- set_reminder only when');
    expect(idx).toBeGreaterThan(-1);
    expect(src.indexOf('VTID-04640')).toBeGreaterThan(idx);
    expect(src.indexOf('VTID-04640')).toBeLessThan(src.indexOf('${buildToolAckIntentLine()}', idx));
  });

  it('is not gated on the member surface (reminders exist everywhere)', () => {
    const before = src.slice(0, src.indexOf('VTID-04640'));
    const lastGate = before.lastIndexOf('${!isMemberSurface');
    const setReminder = before.lastIndexOf('- set_reminder only when');
    expect(lastGate).toBeLessThan(setReminder);
  });

  it('maps the memory phrasings to remember_fact / search_memory', () => {
    for (const p of ['erinnere DICH', 'merk dir', 'im Gedächtnis', 'woran erinnerst du dich']) {
      expect(line).toContain(p);
    }
    expect(line).toContain('remember_fact');
    expect(line).toContain('search_memory');
  });

  it('only allows set_reminder with a time the user said, and asks when unclear', () => {
    expect(line).toContain('erinnere MICH');
    expect(line).toMatch(/set_reminder only when they want to be prompted later at a time they said/);
    expect(line).toMatch(/Unsure → ask/);
  });

  it('keeps the delete_reminder confirmation rule', () => {
    expect(line).toMatch(/delete_reminder only once confirmed \(confirmed=true\)/);
  });

  it('states intent, never a finished spoken German sentence (NEVER rule 41)', () => {
    expect(line).not.toMatch(/Say exactly/i);
    expect(line).not.toMatch(/Soll ich/);
  });
});
