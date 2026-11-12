-- VTID-04880 (locale-zh-gap): fill the one empty zh field found by the read-only query (topic T183,
-- explanation_when_to_use). Draft: DO NOT APPLY, DO NOT MERGE until the zh text is reviewed by a native speaker.
-- Idempotent: only writes when the field is still empty. Updates an existing zh row; does not create one.
-- Source (en, read 2026-11-12 via the protected zh-gap-query job): "Create a draft when you have a nice idea or
-- experience to share with the MAXINA community, but want to think over the text one more time."
UPDATE public.journey_checklist_translations
   SET explanation_when_to_use = '当你有一个想与 MAXINA 社区分享的好想法或经验，但还想再斟酌一下文字时，可以先保存为草稿。'
 WHERE locale = 'zh'
   AND topic_id = 'T183'
   AND coalesce(explanation_when_to_use, '') = '';
