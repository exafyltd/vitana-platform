-- VTID-01066 Registration Script
-- ORB Conversation Stream v1: Voice-First Live Flow (Follow, Speak Cursor, Interrupt)
-- Run this to register VTID-01066 in OASIS before deploying

INSERT INTO vtid_ledger (
    id,
    vtid,
    task_family,
    task_type,
    layer,
    module,
    title,
    description,
    summary,
    status,
    tenant,
    is_test,
    metadata,
    created_at,
    updated_at
) VALUES (
    gen_random_uuid()::TEXT,
    'VTID-01066',
    'UI',
    'ENHANCEMENT',
    'PLATFORM',
    'GATEWAY',
    'ORB Conversation Stream v1: Voice-First Live Flow',
    'Make the ORB conversation stream voice-first, readable, and live: (1) Messages appear as a live stream with message type distinctions (user voice/text, assistant spoken/thinking, system), (2) Speaking cursor + progress highlight during TTS, (3) Interrupt support (voice or button) with visual feedback.',
    'Voice-first ORB conversation stream with thinking placeholder, speaking cursor/progress, and interrupt UX.',
    'in_progress',
    'vitana',
    false,
    jsonb_build_object(
        'type', 'frontend_enhancement',
        'scope', 'command-hub',
        'features', jsonb_build_array(
            'Message type styling (voice/text/spoken/thinking/system)',
            'Thinking placeholder with animated dots',
            'Speaking cursor (blinking caret)',
            'Progress edge bar during TTS',
            'Stop button during speaking',
            'Voice interrupt (barge-in)'
        ),
        'css_classes', jsonb_build_array(
            '.orb-live-message--voice',
            '.orb-live-message--text',
            '.orb-live-message--spoken',
            '.orb-live-message--thinking',
            '.orb-live-message--system',
            '.orb-live-message.is-speaking',
            '.speak-dur-1', '.speak-dur-2', '.speak-dur-3', '.speak-dur-4',
            '.orb-stop-tts',
            '.orb-speaking'
        ),
        'files', jsonb_build_array(
            'services/gateway/src/frontend/command-hub/app.js',
            'services/gateway/src/frontend/command-hub/styles.css',
            'services/gateway/dist/frontend/command-hub/app.js',
            'services/gateway/dist/frontend/command-hub/styles.css'
        )
    ),
    NOW(),
    NOW()
)
ON CONFLICT (vtid) DO UPDATE SET
    title = EXCLUDED.title,
    description = EXCLUDED.description,
    summary = EXCLUDED.summary,
    status = EXCLUDED.status,
    metadata = EXCLUDED.metadata,
    updated_at = NOW();

SELECT vtid, title, status FROM vtid_ledger WHERE vtid = 'VTID-01066';
