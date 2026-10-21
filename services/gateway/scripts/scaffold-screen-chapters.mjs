#!/usr/bin/env node
// Generate baseline chapter markdown for every maxina-relevant screen.
// Skips files that already exist so hand-written chapters are preserved.
// Run once to scaffold; admins polish via Command Hub afterwards.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const INVENTORY = join(REPO_ROOT, 'services/gateway/specs/dev-screen-inventory-v1.json');
const ROOT = join(REPO_ROOT, 'services/gateway/src/kb/instruction-manual/maxina');

const EXCLUDED = new Set([
  'COM-ALKALMA_LOGIN', 'COM-EARTHLINKS_LOGIN', 'COM-COMMUNITY_LOGIN', 'COM-EXAFY_LOGIN',
  'COM-CONFIRM_ALKALMA', 'COM-CONFIRM_EARTHLINKS', 'COM-CONFIRM_COMMUNITY', 'COM-CONFIRM_EXAFY',
]);

const MODULE_NUMBERS = {
  Public: 1, Home: 2, Community: 3, Discover: 4, Health: 5, Inbox: 6,
  AI: 7, Wallet: 8, Sharing: 9, Memory: 10, Settings: 11, Utility: 12, Overlays: 13,
};

// Per-module narrative seed — used to bootstrap distinctive prose.
const MODULE_THEME = {
  Public:    { what: 'a public-facing screen that runs before you sign in (or right after, in confirmation flows)', why: 'this is the first impression the system makes on a new Maxina visitor; the design choices here decide whether someone bounces or commits', use: 'most users see this screen exactly once, but the path it puts you on shapes the rest of your account' },
  Home:      { what: 'part of the Home feed — the daily landing surface where Vitana surfaces what is most relevant for you today', why: 'Home is the screen you open first every day; the cards here decide what gets your attention before the day starts pulling you elsewhere', use: 'open it once each morning, scan the cards, act on one or two, then move on' },
  Community: { what: 'part of the Community module — the social layer of Maxina where you meet, attend, and grow with other members', why: 'longevity and wellness compound when they are shared; the community surface is where motivation and accountability come from', use: 'browse, RSVP, or join — most actions reward credits and grow your community standing' },
  Discover:  { what: 'part of the Discover marketplace — the catalog of products and services curated to your health profile and Life Compass', why: 'when Vitana recommends a supplement, a coach, or a deal, it is matching real inventory against your actual data; the marketplace is the fulfilment layer', use: 'browse, compare, add to cart; most listings can be paid in fiat or credits, and earning rewards apply on first purchase' },
  Health:    { what: 'part of the Health module — where your Vitana Index, your pillars, your biomarkers, and your active plans live', why: 'this is the substance of what Vitana measures and improves; everything on the Autopilot ranks against the data on these screens', use: 'open Health when you want to dig past the headline number — the bars, the recent activity, the trajectory all live here' },
  Inbox:     { what: 'part of the Inbox — your messages, reminders, and inspiration in one place', why: 'most apps split notifications across mail, push, and in-app; Inbox is the consolidated thread where everything that needs your attention surfaces', use: 'process top-down, archive what is done, snooze what can wait, and respond to direct conversations like you would in any messenger' },
  AI:        { what: 'part of the AI tab — the surfaces dedicated to insights, recommendations, and the personal AI companion', why: 'the AI tab is where Vitana shows its work — what it inferred about you, what it would do next, and why', use: 'open it weekly to read the Daily Summary trend; tap into Recommendations to see what the Autopilot would queue up' },
  Wallet:    { what: 'part of the Wallet module — credits, tokens, fiat, subscriptions, and the rewards ledger', why: 'Vitana has a real economy — purchases, peer payments, staking, recurring subscriptions — and the Wallet is where you manage all of it transparently', use: 'check the balance card before a marketplace purchase; review Rewards monthly to see what your activity earned' },
  Sharing:   { what: 'part of the Sharing module — the centre that broadcasts your milestones to channels you opt in to, and the consent layer for what gets shared', why: 'community accountability works when the right people see your wins; Sharing decides who sees what, and lets you publish to social channels when you choose to', use: 'configure once, then let Autopilot drive most of it; review Data & Consent if anything ever feels too public' },
  Memory:    { what: 'part of the Memory module — your timeline, your diary, your recall search, and the permissions that gate it all', why: 'memory is what makes Vitana feel like it actually knows you across months and devices; the Memory module is where you see, search, and curate what is stored', use: 'open Memory to recall something specific, to add a memory by hand, or to audit what Vitana has captured about you' },
  Settings:  { what: 'part of Settings — preferences, privacy, billing, integrations, and account-level controls', why: 'Settings is the surface that lets you tune Vitana to your situation, revoke things you no longer want, and stay in control of the account', use: 'visit when something is wrong, when you want to connect a tracker, or when a renewal needs attention' },
  Utility:   { what: 'a utility surface available across the platform — Calendar, Search, Profile, or the AI Assistant chat', why: 'utility screens are tools, not feeds; they are where you search, schedule, and edit identity rather than consume', use: 'open them on demand when you need a specific outcome — find a memory, edit your handle, schedule an event' },
  Overlays:  { what: 'a global overlay that opens on top of any screen — the Orb, drawers, popups, and quick action menus', why: 'overlays are the cross-cutting UI that lets you keep your context while doing a quick action; they appear over the screen you are already on instead of taking you somewhere new', use: 'invoked from a button, a tap on an item, or a voice command; close with the X or Escape to return to where you were' },
};

function chapterFor(screen, idx) {
  const moduleNum = MODULE_NUMBERS[screen.module];
  const slug = screen.screen_id.replace(/^COM-/, '').toLowerCase().replace(/_/g, '-');
  const dir = join(ROOT, `${String(moduleNum).padStart(2, '0')}-${screen.module.toLowerCase()}`);
  const file = join(dir, `${slug}.md`);
  const chapter = `${moduleNum}.${idx}`;
  const theme = MODULE_THEME[screen.module] || MODULE_THEME.Utility;
  const tabLabel = screen.tab;
  const url = screen.url_path;
  const isOverlay = screen.module === 'Overlays' || url === '(global overlay)';
  const sidebarPath = isOverlay
    ? `${screen.module}: ${tabLabel} (opens over any screen)`
    : `${screen.module} → ${tabLabel}`;
  const urlLabel = isOverlay ? 'Opens as an overlay over the current screen.' : `Direct URL: \`${url}\`.`;

  const keywords = [
    tabLabel.toLowerCase(),
    screen.screen_id.replace(/^COM-/, '').toLowerCase().replace(/_/g, ' '),
    slug.replace(/-/g, ' '),
    screen.module.toLowerCase(),
  ];
  const fm = [
    '---',
    `chapter: ${chapter}`,
    `screen_id: ${screen.screen_id}`,
    `title: ${tabLabel}`,
    `tenant: maxina`,
    `module: ${screen.module}`,
    `tab: ${tabLabel}`,
    `url_path: ${url}`,
    `sidebar_path: ${sidebarPath}`,
    `keywords: [${keywords.map((k) => k.replace(/[\[\]"]/g, '')).join(', ')}]`,
    `related_concepts: []`,
    `related_screens: []`,
    '---',
    '',
  ].join('\n');

  const body = `## What it is

The **${tabLabel}** screen is ${theme.what}. In the navigation it sits at ${sidebarPath}, and ${urlLabel.replace(/\.$/, '')}. This chapter explains what the screen contains, why a Maxina community user would open it, what they will see when they do, and how to act on what is there.

## Why it matters

${theme.why.charAt(0).toUpperCase() + theme.why.slice(1)}. Every Maxina member arrives at this screen at some point in their first 30 days — sometimes via the Did You Know guided tour, sometimes by tapping a card on Home, sometimes by asking ORB "show me the ${tabLabel.toLowerCase()}". Knowing why the screen exists is what stops it from feeling like noise the next time you land here.

## Where to find it

${urlLabel} ${isOverlay ? 'It is invoked from buttons or voice commands across the rest of the system; you do not navigate to it directly.' : `It lives under the **${screen.module}** module of the sidebar, on the tab labelled **${tabLabel}**.`} If you ask ORB "open the ${tabLabel.toLowerCase()}" the Navigator will route you straight here.

## What you see on this screen

This section is the screen-level inventory of panels, cards, buttons, and information. It is what Vitana reads aloud when a user asks "what's on this screen?". A maxina admin should expand this list with the exact components currently rendered. Until polished, expect to see the standard layout for the ${screen.module} module: a header with the screen title, the primary content area filled with the cards or list described by the screen's purpose, and any module-specific toolbar in the sidebar or top-right. Anything truly distinctive about the **${tabLabel}** screen — counts, filters, special actions — should be enumerated here as bullet points by the admin via the Command Hub Manuals tab.

- Header: the screen title (${tabLabel}) and any quick-action buttons for this module
- Main content area: the panels or list described by the screen's purpose
- Empty state: friendly first-run copy if you have not yet engaged with this surface
- Action buttons: the primary call-to-action for this screen (often "Add", "Open", "RSVP", or "Save" depending on context)

## How to use it

1. Open the screen via the sidebar (${sidebarPath}) or by asking ORB "open ${tabLabel.toLowerCase()}".
2. ${theme.use.charAt(0).toUpperCase() + theme.use.slice(1)}.
3. If you are not sure what something on the screen means, ask ORB "what is this card?" — Vitana will read the relevant chapter section aloud.
4. To leave the screen, use the back button or open another sidebar item; nothing on this screen requires you to "save and exit" — your state is persisted automatically.
5. Many screens in the ${screen.module} module pair with a related screen: see the related-screens list below for the next logical place to look.

## Related

- See module ${moduleNum} for the other screens in **${screen.module}**.
- See the foundational concepts (chapter 0.x) for cross-cutting vocabulary referenced on this screen.
`;

  return { file, dir, content: fm + body, chapter };
}

const inv = JSON.parse(readFileSync(INVENTORY, 'utf8'));
const community = [];
const walk = (n) => {
  if (Array.isArray(n)) return n.forEach(walk);
  if (n && typeof n === 'object') {
    if (n.screen_id && n.role === 'COMMUNITY') community.push(n);
    else Object.values(n).forEach(walk);
  }
};
walk(inv);

// Group by module preserving inventory order so chapter numbers are stable
const byModule = new Map();
for (const s of community) {
  if (EXCLUDED.has(s.screen_id)) continue;
  if (!byModule.has(s.module)) byModule.set(s.module, []);
  byModule.get(s.module).push(s);
}

let written = 0, skipped = 0;
for (const [, screens] of byModule) {
  screens.forEach((screen, i) => {
    const { file, dir, content } = chapterFor(screen, i + 1);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(file)) { skipped++; return; }
    writeFileSync(file, content);
    written++;
  });
}

console.log(`Scaffold complete: ${written} new chapters written, ${skipped} existing chapters preserved.`);
