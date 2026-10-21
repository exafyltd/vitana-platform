/**
 * VTID-04986: regen-screens-catalog.mjs must not crash on an icon it has
 * never seen.
 *
 * The generator evaluates vitana-v1's `ADMIN_SECTIONS` literal, which
 * references lucide-react icons as bare identifiers (`icon: Inbox`). It used
 * a fixed list of icon stubs, so the first new icon (`Inbox`, then
 * `Briefcase`) made every run die with `ReferenceError: Inbox is not
 * defined` and the screen inventory stopped regenerating. The stubs are now
 * derived from the literal itself.
 *
 * Driven through a spawned Node process: Jest's `import()` cannot load a bare
 * `.mjs` module (see dev-autopilot-todo-scanner-self-match.test.ts).
 */

import * as path from 'path';
import { execFileSync } from 'child_process';

const SCRIPT = path.resolve(__dirname, '../../scripts/regen-screens-catalog.mjs');

const FIXTURE = `
import { LayoutDashboard, SomeIconAddedNextYear } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface AdminSection { key: string; icon: LucideIcon; tabs: unknown[] }

export const ADMIN_SECTIONS: AdminSection[] = [
  {
    key: "overview",
    label: "Overview",
    icon: LayoutDashboard,
    basePath: "/admin",
    wave: 1,
    tabs: [{ key: "dashboard", label: "Dashboard", path: "/admin/dashboard" }],
  },
  {
    // A comment that mentions NotAnIdentifierInCode must not matter.
    key: "future",
    label: "Future: icon: Fake", // colons and words inside strings are not identifiers
    icon: SomeIconAddedNextYear,
    basePath: "/admin/future",
    wave: 2,
    tabs: [
      { key: "inbox", label: "Inbox", path: "/admin/future/inbox" },
      { key: "board", label: \`Board\`, path: '/admin/future/board' },
    ],
  },
];
`;

function runDriver(body: string): any {
  const driver = [
    `import * as m from ${JSON.stringify(SCRIPT)};`,
    `const FIXTURE = ${JSON.stringify(FIXTURE)};`,
    body,
  ].join('\n');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', driver], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  return JSON.parse(out);
}

describe('VTID-04986: regen-screens-catalog dynamic icon stubs', () => {
  it('parses ADMIN_SECTIONS that reference an icon the generator has never seen', () => {
    const sections = runDriver(
      `process.stdout.write(JSON.stringify(m.parseAdminSections(FIXTURE).map(s => ({ key: s.key, tabs: s.tabs.map(t => t.path) }))));`,
    );
    expect(sections).toEqual([
      { key: 'overview', tabs: ['/admin/dashboard'] },
      { key: 'future', tabs: ['/admin/future/inbox', '/admin/future/board'] },
    ]);
  });

  it('stubs every bare identifier and nothing inside strings or comments', () => {
    const names: string[] = runDriver(
      `const lit = FIXTURE.slice(FIXTURE.indexOf('export const ADMIN_SECTIONS'));
       process.stdout.write(JSON.stringify(m.collectBareIdentifiers(lit.slice(lit.indexOf('['), lit.lastIndexOf(']') + 1))));`,
    );
    expect(names).toEqual(expect.arrayContaining(['LayoutDashboard', 'SomeIconAddedNextYear']));
    expect(names).not.toContain('Fake');
    expect(names).not.toContain('NotAnIdentifierInCode');
    expect(names).not.toContain('Board');
  });

  it('gives each stub an inert frozen value', () => {
    const r = runDriver(
      `const ctx = m.buildIdentifierStubs('[{ icon: Inbox }]');
       process.stdout.write(JSON.stringify({ keys: Object.keys(ctx), frozen: Object.isFrozen(ctx.Inbox), v: ctx.Inbox }));`,
    );
    // Property keys (`icon`) are stubbed too; an extra stub is harmless.
    expect(r).toEqual({ keys: ['Inbox', 'icon'], frozen: true, v: { __stub: 'Inbox' } });
  });

  it('does not run the regen (or write files) when imported', () => {
    const r = runDriver(`process.stdout.write(JSON.stringify({ ok: typeof m.parseAdminSections }));`);
    expect(r).toEqual({ ok: 'function' });
  });
});
