# Partner Terms v1 (`2026-10`) — DRAFT · COUNSEL REVIEW · NOT PUBLICATION-APPROVED

VTID-04910. Drafted 2026-10-06.

**Status: draft text only.** No `partner_terms_versions` row exists for it, nothing is published, nothing is
accepted. Creating the draft row, publishing it and any acceptance each need the owner's explicit approval
after final legal review.

## Files

| Code | File | Role |
|---|---|---|
| `de` | `de.md` | **Canonical and legally binding** (source of every translation) |
| `en` | `en.md` | Second language (required) |
| `es` `sr` `fr` `pt-BR` `ru` `pl` `ar` `zh-CN` `tr` | `<code>.md` | Translations for understanding, made from the German |

Format: line 1 is `# <title>`; everything after it is the body (`body_md`). Clause numbering, list lettering,
markers and placeholders are identical in all 11 files — `services/gateway/test/vtid-04910-partner-terms-draft-text.test.ts`
fails the build otherwise, and checks that the 11 files form valid content for the admin API (German binding,
English present, exact codes).

## Proposed version metadata

- `version`: `2026-10`
- `requires_reacceptance`: `true` (first version — every applicable supplier accepts it)
- Canonical hash once published: `sha256(UTF-8(de.title + "\n" + de.body_md))` (VTID-04909).

## Before publication

1. **Counsel review** of the clauses marked `FINAL LEGAL COUNSEL REVIEW REQUIRED BEFORE PUBLICATION`:
   §15 Haftung, §16 Freistellung, §20 Anwendbares Recht und Gerichtsstand. Owner instructions (2026-10-06):
   - §15: remove/revise German-law concepts that may not map to UAE/ADGM law (e.g. Vorsatz, grobe
     Fahrlässigkeit, „nach den gesetzlichen Vorschriften“); review the cap formula — it must not become zero
     just because a partner paid VITANALAND no fees.
   - §16: review against UAE/ADGM law rather than German-law fault concepts („zu vertreten“); keep it
     proportionate and tied to partner-controlled breaches/claims.
   - §20: confirm the governing-law formulation.
2. **§20.2 is marked `FINAL LEGAL COUNSEL CONFIRMATION REQUIRED`.** EXAFY LTD is registered in ADGM, which
   has its own courts. Counsel must confirm whether disputes go to the ADGM Courts or the onshore Abu Dhabi
   courts, and whether jurisdiction is exclusive or non-exclusive. The current sentence („die zuständigen
   Gerichte in Abu Dhabi“) is not final; no choice has been made.
3. **Placeholder** `[LEGAL NOTICE CONTACT TO CONFIRM]` (§21.1) stays until the owner supplies a contact formally
   approved to receive legal notices — never a support address by default.
4. If German §15, §16 or §20 changes, every translation is redone from the revised German and the QA test
   re-run. Translations are never fixed independently in ways that add obligations not in the German.

## Company identification

From the ADGM commercial licence extract supplied by the owner (generated 30 September 2026): EXAFY LTD,
Private Company Limited by Shares, ADGM registered number 000006675, DD-16-121-018, Floor 16, Al Khatem Tower,
WeWork Hub71, ADGM Square, Al Maryah Island, Abu Dhabi, United Arab Emirates. Nothing else (tax or other
numbers) is used.

## Further points raised for counsel during drafting and translation

- §15.2 may read as excluding non-contractual liability; „aus Geschäften mit dem Partner“ needs a definition.
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
