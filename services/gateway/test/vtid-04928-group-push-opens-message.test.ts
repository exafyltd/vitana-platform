/**
 * VTID-04928 — every group-message push opens the message that was received.
 *
 * Owner report 2026-10-06: tapping a group-chat push landed on the group's
 * oldest message. The pushes linked to /inbox/g/<groupId> although they carry
 * message_id. Each site that sends a group-message push must link to
 * /inbox/g/<groupId>/msg/<messageId>; the app scrolls to and highlights it.
 *
 * The send fanout is exercised end to end in vtid-04926-chat-group-mentions;
 * this guards all three sites (send fanout, welcome re-fanout, ORB voice send)
 * at the source so a new edit cannot quietly drop the message id again.
 */
import * as fs from 'fs';
import * as path from 'path';

const SITES = [
  'src/routes/chat-groups.ts',
  'src/services/orb-tools/messaging-depth-tools.ts',
];

describe('group-message pushes deep-link to the message (VTID-04928)', () => {
  for (const rel of SITES) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

    it(`${rel}: no push url points at the bare group`, () => {
      const urls = src.match(/url:\s*`\/inbox\/g\/[^`]*`/g) ?? [];
      expect(urls.length).toBeGreaterThan(0);
      for (const u of urls) expect(u).toMatch(/\/msg\/\$\{[^}]+\}`$/);
    });
  }
});
