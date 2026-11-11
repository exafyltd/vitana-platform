// VTID-05695 (plan session-handover-gitlab): CLAUDE.md carries the standing rule that every session handover is pushed to GitLab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const text = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
const start = text.indexOf('## 📦 SESSION HANDOVER: STRAIGHT TO GITLAB');
const section = start < 0 ? '' : text.slice(start, text.indexOf('\n---', start) < 0 ? undefined : text.indexOf('\n---', start));

test('CLAUDE.md has the session handover section after the collaboration section', () => {
  assert.ok(start > 0, 'section heading missing');
  assert.ok(text.indexOf('## 🤝 CLAUDE CODE ↔ KIRO COLLABORATION') < start, 'section must follow the collaboration section');
});

test('the section names the GitLab handover file, the sandbox fact and the push check', () => {
  assert.match(section, /19-EXECUTION-PROGRAMME\/SESSION-HANDOVER\.md/);
  assert.match(section, /vitana\/vitanaland-strategy/);
  assert.match(section, /fresh sandbox/);
  assert.match(section, /git ls-remote origin <branch>/);
  assert.match(section, /a handover exists only once it is pushed to GitLab/);
});
