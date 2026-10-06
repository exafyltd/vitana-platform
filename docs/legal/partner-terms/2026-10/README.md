# Partner Terms v1 (`2026-10`) — APPROVED FOR V1 · NOT YET PUBLISHED

VTID-04910 (drafted 2026-10-06), VTID-04911 (final cleanup 2026-10-06).

**Status: legal text accepted by the owner for v1 as drafted (2026-10-06); no additional external counsel
review is required before v1.** No `partner_terms_versions` row exists for it, nothing is published, nothing is
accepted. Creating the draft row, publishing it and any acceptance each still need the owner's explicit
approval.

## Files

| Code | File | Role |
|---|---|---|
| `de` | `de.md` | **Canonical and legally binding** (source of every translation; the hash is over this text) |
| `en` | `en.md` | Second language (required) |
| `es` `sr` `fr` `pt-BR` `ru` `pl` `ar` `zh-CN` `tr` | `<code>.md` | Translations for understanding, made from the German |

Format: line 1 is `# <title>`; everything after it is the body (`body_md`). Clause numbering and list lettering
are identical in all 11 files — `services/gateway/test/vtid-04910-partner-terms-draft-text.test.ts` fails the
build otherwise, and checks that the 11 files form valid content for the admin API (German binding, English
present, exact codes).

## Version metadata

- `version`: `2026-10`
- `requires_reacceptance`: `true` (first version — every applicable supplier accepts it)
- Canonical hash once published: `sha256(UTF-8(de.title + "\n" + de.body_md))` (VTID-04909).

## Final changes (VTID-04911, owner instruction 2026-10-06)

- §21.1 names the legal notice address and `legal@vitanaland.com` in all 11 languages (the email is never
  translated or altered).
- The internal counsel-review markers were removed from all 11 files. The clause text of §15, §16, §19 and §20
  is unchanged; §20 keeps UAE law and the competent courts in Abu Dhabi, with no ADGM/onshore distinction and
  no arbitration.

## Legal notices

EXAFY LTD, DD-16-121-018, Floor 16, Al Khatem Tower, WeWork Hub71, ADGM Square, Al Maryah Island, Abu Dhabi,
United Arab Emirates; legal@vitanaland.com.

## Company identification

From the ADGM commercial licence extract supplied by the owner (generated 30 September 2026): EXAFY LTD,
Private Company Limited by Shares, ADGM registered number 000006675, DD-16-121-018, Floor 16, Al Khatem Tower,
WeWork Hub71, ADGM Square, Al Maryah Island, Abu Dhabi, United Arab Emirates. Nothing else (tax or other
numbers) is used.

## Changing the text later

A change to the German text is a new version: every translation is redone from the revised German and the QA
test re-run. Translations are never changed independently in ways that add obligations not in the German.

## Notes recorded during drafting (not blocking v1)

Kept for a future revision; the owner accepted the v1 text as drafted.

- §15.2 may read as excluding non-contractual liability; „aus Geschäften mit dem Partner“ could be defined.
- §16 has no defence-control / settlement procedure; §16.1 g) is a broad catch-all.
- §17.3 has no notice period or materiality threshold; §17.4 survival wording.
- §18.2 does not state the consequence of not re-accepting (system today: the terms step reopens, live
  suppliers stay live).
- §1.4 exclusion of the partner's own terms without objection; §8.5 vs §1.3 precedence for data terms.
- „Sicherheit“ covers safety and security; translations chose by context (§6.1 c, §13.1, §17.3).
- VITANALAND is a brand; the licence names EXAFY LTD only.

## Register

The terms are written in the third person („der Partner“). The acceptance wording and the binding-language
notice in the app use the formal „Sie“ form on purpose (owner decision 2026-10-06): a contractual statement of
authority and consent is an intentional exception to the app's du-form, not a localisation error.
