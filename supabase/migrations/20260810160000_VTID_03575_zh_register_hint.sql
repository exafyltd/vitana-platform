-- VTID-03575 (companion to VTID-03569) — correct the Chinese register hint in `supported_locales`.
--
-- `informal_hint` is not documentation. It is fed verbatim into the DB-content
-- translation prompt (services/gateway/src/scripts/seed-db-i18n.ts, via the
-- surface registry), so whatever this column says is what the model is told.
--
-- The seeded value was 'Simplified Chinese, informal. Needs a CJK font stack.'
-- Two problems with using that as an instruction:
--
--   1. The second sentence is a note to US about the frontend, and it is now
--      stale — the CJK stack shipped with this VTID. Left in place it spends
--      prompt on a build-system fact the model can do nothing with.
--   2. 'informal' alone is not actionable in Chinese. Register here is carried
--      by a distinct PRONOUN CHARACTER — 您 is polite, 你 ordinary — not by
--      verb morphology, so the instruction has to name the characters. The
--      frontend rule (scripts/i18n-register-rules.mjs) already does; this is
--      the same instruction for the surfaces that never pass through git.
--
-- Script is restated because it is a SEPARATE axis from register: a model told
-- only 'informal Chinese' can return Traditional, which is wrong for zh-CN and
-- which a register check cannot see, because it looks at pronouns.
--
-- Status stays 'draft'. This corrects what zh is told, not whether it ships.
--
-- impact-allow-solo-migration
--
-- Deliberate solo migration. The impact rule asks for a code change in the same
-- PR or an explicit confirmation that existing code already uses this. The
-- latter holds: `informal_hint` is already READ by the seeder's surface
-- registry and passed into the translation prompt — this UPDATE changes the
-- VALUE of a column that is already wired, not the schema. Nothing new needs
-- writing to consume it. Pure data backfill, one row, no DDL.

UPDATE public.supported_locales
   SET informal_hint = 'Use Simplified Chinese (zh-CN) and the ordinary second person 你/你的. Never the polite 您. Do not return Traditional characters. Direct, friendly tone.'
 WHERE code = 'zh';
