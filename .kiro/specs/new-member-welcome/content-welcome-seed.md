# Team-welcome seed wording (tt() catalog) — for sparring and locale review

Author: kiro, 2026-10-15. This is the **Option A (catalog)** seed wording for the three team
welcome DMs (design.md §A.2, requirement 1.4). Status: DRAFT for the sparring partner and
(Owner decision 2026-10-15: no per-sender approval step — the welcomes are sent automatically.)

Conventions (verified against `services/gateway/src/i18n/catalog.ts` + `locales/*.json`):
- Keys registered in `catalog.ts` (`GatewayI18nKey` union); translations in
  `locales/<locale>.json`. 11 locales: de en es sr fr pt ru pl zh ar tr. German is default;
  fallback locale → en → de → key. `ar` ships intentionally near-empty (gaps fall back
  visibly), so an `ar` line is desirable but not required for first ship.
- `{name}` = recipient's first name (resolved from the newcomer's profile; omit gracefully
  if unknown — see the no-name variant note under each sender).
- **du-form**, warm, natural, concise. One short message each. The rule-41 ban on hardcoded
  sentences does NOT apply here: these are written messages FROM named people, governed by
  the catalog rule (VOA §4.5.5 precedent). Owner decision 2026-10-15: no per-sender
  approval step; the wording goes through the normal locale review only.
- These are chat DM bodies (not push), so no title key — one body key per sender.
- Per-locale status starts `unverified` and flips to `ready` only after the locale review,
  same as every other catalog addition.

## Keys to register in catalog.ts

```ts
  | 'welcome_team.mariia.body'
  | 'welcome_team.jovana.body'
  | 'welcome_team.alex.body'
```

---

## 1. Mariia Maksina (@mariia04) — warm personal welcome
Intent: how lovely you've joined; the community is here to support one another in improving
health and wellbeing. Personal, from the communication centre.

**en** (`welcome_team.mariia.body`):
> Hi {name}, it's so lovely to have you with us! 💛 Welcome to MAXINA. We're a community that
> looks out for one another on the way to better health and wellbeing, and I'm really glad
> you're here.

**de**:
> Hallo {name}, wie schön, dass du da bist! 💛 Herzlich willkommen bei MAXINA. Wir sind eine
> Gemeinschaft, die sich gegenseitig auf dem Weg zu mehr Gesundheit und Wohlbefinden
> unterstützt – und ich freue mich sehr, dass du dabei bist.

No-name variant (en): "Hi there, it's so lovely to have you with us! 💛 Welcome to MAXINA…"

## 2. Jovana Tadić (@jovana4) — friendly community welcome
Intent: friendly community welcome; encourage them to introduce themselves, join
conversations, and feel comfortable taking part.

**en** (`welcome_team.jovana.body`):
> Hey {name}, welcome to the MAXINA community! 👋 Whenever you feel like it, say a little
> hello and tell us a bit about yourself — jump into any conversation that interests you.
> There's no pressure at all; we're happy to have you here.

**de**:
> Hey {name}, willkommen in der MAXINA-Community! 👋 Wenn du magst, stell dich kurz vor und
> erzähl ein bisschen von dir – und misch dich einfach in jedes Gespräch ein, das dich
> interessiert. Ganz ohne Druck; schön, dass du da bist.

No-name variant (en): "Hey there, welcome to the MAXINA community! 👋 …"

## 3. Alex Blue (@dragan1) — technical-support contact (REAL HUMAN, no AI claim)
Intent (owner-provided meaning): "Hi, I'm Alex 👋 If you need any help with the technical
side of MAXINA, something isn't working, or you're unsure how to use a feature, just message
me here. I'll be happy to help!" Approachable, reassuring. **No promise of an immediate
reply. No AI-identity line** (Alex Blue is a real human — owner decision 2026-10-15).

**en** (`welcome_team.alex.body`):
> Hi {name}, I'm Alex 👋 I help out with the technical side of MAXINA. If something isn't
> working, or you're not sure how a feature works, just message me here and I'll be glad to
> help you sort it out.

**de**:
> Hallo {name}, ich bin Alex 👋 Ich kümmere mich um die technische Seite von MAXINA. Falls
> mal etwas nicht funktioniert oder du nicht weißt, wie eine Funktion geht, schreib mir
> einfach hier – ich helfe dir gern weiter.

No-name variant (en): "Hi there, I'm Alex 👋 I help out with the technical side of MAXINA. …"

Note: the message deliberately avoids "right away"/"immediately". It says "message me here"
(reply reaches Alex's normal inbox) and "glad to help", setting a supportive but
non-time-bound expectation.

---

## Remaining 9 locales (es sr fr pt ru pl zh ar tr)
Translate the three bodies above to each locale, du-/informal form, keeping: the recipient
`{name}` placeholder, one emoji max per message, Alex's no-AI / no-immediate-reply framing,
and the warm/concise tone. Provided to translators as the EN source + these intent notes;
each lands `unverified` → `ready` after review. `ar` is RTL and may ship after first release
(visible fallback to en/de meanwhile), consistent with the existing `ar` catalog gap.

## Open points for the senders / sparring
- Mariia's account display_name is "maksinamariia" (not "Mariia Maksina"); if the DM renders
  a "from" name from the account, fix the account before go-live (design S6).
- ~~Each sender confirms their own wording and consents to the automation once~~ — removed by owner decision 2026-10-15; the
  welcomes are sent automatically (recorded in the sparring record and the lane VTIDs).
