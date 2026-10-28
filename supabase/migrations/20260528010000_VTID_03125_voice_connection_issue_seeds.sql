-- Phase D.2 (decision-contract refactor) — connection-issue render blocks.
--
-- VTID-03125. Externalizes the 8-language `connectionIssueMessages`
-- Record currently exported by `services/gateway/src/orb/upstream/constants.ts`
-- into the `policy_render_block` table seeded by Phase B.1.
--
-- Idempotent: each INSERT is guarded by WHERE NOT EXISTS against the
-- same (block_key, language, tenant_id, version). Safe to re-run.
--
-- Content is BYTE-IDENTICAL to the Record entries at the time of
-- writing. The constants.ts file keeps the same strings as the
-- `defaultValue` arg for cache-cold safety; this migration is the
-- production source of truth.

INSERT INTO policy_render_block (block_key, language, tenant_id, version, content, source, notes)
SELECT 'voice.connection_issue', 'en', NULL, 1,
       'I''m sorry, I seem to be having connection issues right now. Please try starting a new conversation.',
       'seed', 'orb/upstream/constants.ts:163 (connectionIssueMessages.en)'
WHERE NOT EXISTS (
  SELECT 1 FROM policy_render_block
  WHERE block_key = 'voice.connection_issue' AND language = 'en'
    AND tenant_id IS NULL AND version = 1
);

INSERT INTO policy_render_block (block_key, language, tenant_id, version, content, source, notes)
SELECT 'voice.connection_issue', 'de', NULL, 1,
       'Es tut mir leid, ich habe gerade Verbindungsprobleme. Bitte versuchen Sie, ein neues Gespräch zu starten.',
       'seed', 'orb/upstream/constants.ts:164 (connectionIssueMessages.de)'
WHERE NOT EXISTS (
  SELECT 1 FROM policy_render_block
  WHERE block_key = 'voice.connection_issue' AND language = 'de'
    AND tenant_id IS NULL AND version = 1
);

INSERT INTO policy_render_block (block_key, language, tenant_id, version, content, source, notes)
SELECT 'voice.connection_issue', 'fr', NULL, 1,
       'Je suis désolé, j''ai des problèmes de connexion. Veuillez réessayer une nouvelle conversation.',
       'seed', 'orb/upstream/constants.ts:165 (connectionIssueMessages.fr)'
WHERE NOT EXISTS (
  SELECT 1 FROM policy_render_block
  WHERE block_key = 'voice.connection_issue' AND language = 'fr'
    AND tenant_id IS NULL AND version = 1
);

INSERT INTO policy_render_block (block_key, language, tenant_id, version, content, source, notes)
SELECT 'voice.connection_issue', 'es', NULL, 1,
       'Lo siento, parece que tengo problemas de conexión. Por favor, intenta iniciar una nueva conversación.',
       'seed', 'orb/upstream/constants.ts:166 (connectionIssueMessages.es)'
WHERE NOT EXISTS (
  SELECT 1 FROM policy_render_block
  WHERE block_key = 'voice.connection_issue' AND language = 'es'
    AND tenant_id IS NULL AND version = 1
);

INSERT INTO policy_render_block (block_key, language, tenant_id, version, content, source, notes)
SELECT 'voice.connection_issue', 'ar', NULL, 1,
       'عذراً، يبدو أنني أواجه مشاكل في الاتصال. يرجى محاولة بدء محادثة جديدة.',
       'seed', 'orb/upstream/constants.ts:167 (connectionIssueMessages.ar)'
WHERE NOT EXISTS (
  SELECT 1 FROM policy_render_block
  WHERE block_key = 'voice.connection_issue' AND language = 'ar'
    AND tenant_id IS NULL AND version = 1
);

INSERT INTO policy_render_block (block_key, language, tenant_id, version, content, source, notes)
SELECT 'voice.connection_issue', 'zh', NULL, 1,
       '抱歉，我目前似乎遇到了连接问题。请尝试重新开始对话。',
       'seed', 'orb/upstream/constants.ts:168 (connectionIssueMessages.zh)'
WHERE NOT EXISTS (
  SELECT 1 FROM policy_render_block
  WHERE block_key = 'voice.connection_issue' AND language = 'zh'
    AND tenant_id IS NULL AND version = 1
);

INSERT INTO policy_render_block (block_key, language, tenant_id, version, content, source, notes)
SELECT 'voice.connection_issue', 'ru', NULL, 1,
       'Извините, у меня проблемы с подключением. Пожалуйста, попробуйте начать новый разговор.',
       'seed', 'orb/upstream/constants.ts:169 (connectionIssueMessages.ru)'
WHERE NOT EXISTS (
  SELECT 1 FROM policy_render_block
  WHERE block_key = 'voice.connection_issue' AND language = 'ru'
    AND tenant_id IS NULL AND version = 1
);

INSERT INTO policy_render_block (block_key, language, tenant_id, version, content, source, notes)
SELECT 'voice.connection_issue', 'sr', NULL, 1,
       'Извините, изгледа да имам проблеме са везом. Молимо покушајте поново.',
       'seed', 'orb/upstream/constants.ts:170 (connectionIssueMessages.sr)'
WHERE NOT EXISTS (
  SELECT 1 FROM policy_render_block
  WHERE block_key = 'voice.connection_issue' AND language = 'sr'
    AND tenant_id IS NULL AND version = 1
);
