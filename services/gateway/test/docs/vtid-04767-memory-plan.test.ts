/**
 * VTID-04767: the memory plan's revision maps every hard requirement.
 * A row dropped from §8.3 would leave a requirement with no stated answer.
 */
import * as fs from 'fs';
import * as path from 'path';

const plan = fs.readFileSync(path.join(__dirname, '../../../../docs/MEMORY-SYSTEM-PLAN.md'), 'utf8');

describe('VTID-04767 memory plan revision', () => {
  it('has the revision and points to it from the top', () => {
    expect(plan).toContain('## 8. Revision 2026-10-01 — the whole memory (VTID-04767)');
    expect(plan.indexOf('read §8 first')).toBeLessThan(plan.indexOf('## 0. Verdict'));
  });

  it('maps all 22 hard requirements', () => {
    const section = plan.slice(plan.indexOf('### 8.3'), plan.indexOf('### 8.4'));
    for (let n = 1; n <= 22; n++) expect(section).toMatch(new RegExp(`^\\| ${n} \\|`, 'm'));
  });

  it('covers roles, the Garden, the Diary, health, continuity, combining, people and erasure', () => {
    const section = plan.slice(plan.indexOf('### 8.2'), plan.indexOf('### 8.3'));
    for (const topic of ['**Flow rule:**', '**The Memory Garden**', '**The Daily Diary**', '**Health records**', '**Cross-session continuity:**', '**Combining before answering', '**People and relationships', '**Erasure']) {
      expect(section).toContain(topic);
    }
  });
});
