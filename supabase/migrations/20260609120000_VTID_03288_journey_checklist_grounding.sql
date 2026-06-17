-- =============================================================================
-- VTID-03288 / DEV-COMHU-03301 — Guided Journey checklist GROUNDING (P1)
-- Sets the practice-loop fields (guided_practice_target / practice_action_type /
-- completion_event) for T011-T250 so the publish validator passes and every
-- topic has a working teach->practice->complete loop. German teaching PROSE
-- (vitana_voice_script + explanation_*) is produced separately by the Command
-- Hub AI regeneration engine (VTID-03288). Idempotent: only fills NULL targets,
-- never clobbers the T001-T010 authored proof set or later admin edits.
-- =============================================================================

BEGIN;

UPDATE journey_checklist_topics SET
  guided_practice_target = 'five_pillars',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T011',
  updated_at = now()
WHERE topic_id = 'T011' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'weakest_pillar',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T012',
  updated_at = now()
WHERE topic_id = 'T012' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'quality_of_life',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T013',
  updated_at = now()
WHERE topic_id = 'T013' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'health_first',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T014',
  updated_at = now()
WHERE topic_id = 'T014' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'privacy_control',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T015',
  updated_at = now()
WHERE topic_id = 'T015' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'memory_permission',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T016',
  updated_at = now()
WHERE topic_id = 'T016' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'profile_basics',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T017',
  updated_at = now()
WHERE topic_id = 'T017' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'trust_signal',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T018',
  updated_at = now()
WHERE topic_id = 'T018' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'ask_vitana',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T019',
  updated_at = now()
WHERE topic_id = 'T019' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'open_screen',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T020',
  updated_at = now()
WHERE topic_id = 'T020' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'daily_loop',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T021',
  updated_at = now()
WHERE topic_id = 'T021' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'first_practice',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T022',
  updated_at = now()
WHERE topic_id = 'T022' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'sleep',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T023',
  updated_at = now()
WHERE topic_id = 'T023' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'log_sleep',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T024',
  updated_at = now()
WHERE topic_id = 'T024' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'hydration',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T025',
  updated_at = now()
WHERE topic_id = 'T025' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'log_water',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T026',
  updated_at = now()
WHERE topic_id = 'T026' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'movement',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T027',
  updated_at = now()
WHERE topic_id = 'T027' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'log_movement',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T028',
  updated_at = now()
WHERE topic_id = 'T028' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'nutrition',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T029',
  updated_at = now()
WHERE topic_id = 'T029' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'meal_note',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T030',
  updated_at = now()
WHERE topic_id = 'T030' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'mental_strength',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T031',
  updated_at = now()
WHERE topic_id = 'T031' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'one_minute_reset',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T032',
  updated_at = now()
WHERE topic_id = 'T032' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'daily_diary',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T033',
  updated_at = now()
WHERE topic_id = 'T033' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'voice_diary',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T034',
  updated_at = now()
WHERE topic_id = 'T034' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'reminders',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T035',
  updated_at = now()
WHERE topic_id = 'T035' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'set_reminder',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T036',
  updated_at = now()
WHERE topic_id = 'T036' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'calendar',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T037',
  updated_at = now()
WHERE topic_id = 'T037' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'schedule_action',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T038',
  updated_at = now()
WHERE topic_id = 'T038' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'future_paths',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T039',
  updated_at = now()
WHERE topic_id = 'T039' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'business_curiosity',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T040',
  updated_at = now()
WHERE topic_id = 'T040' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'daily_loop',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T041',
  updated_at = now()
WHERE topic_id = 'T041' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'try_autopilot',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T042',
  updated_at = now()
WHERE topic_id = 'T042' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'finish_or_snooze',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T043',
  updated_at = now()
WHERE topic_id = 'T043' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'home_overview',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T044',
  updated_at = now()
WHERE topic_id = 'T044' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'context_tab',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T045',
  updated_at = now()
WHERE topic_id = 'T045' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'ai_feed_judgment',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T046',
  updated_at = now()
WHERE topic_id = 'T046' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'index_drivers',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T047',
  updated_at = now()
WHERE topic_id = 'T047' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'pillar_subscores',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T048',
  updated_at = now()
WHERE topic_id = 'T048' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'choose_driver',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T049',
  updated_at = now()
WHERE topic_id = 'T049' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'sleep_trend',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T050',
  updated_at = now()
WHERE topic_id = 'T050' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'sleep_plan',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T051',
  updated_at = now()
WHERE topic_id = 'T051' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'bedtime_reminder',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T052',
  updated_at = now()
WHERE topic_id = 'T052' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'hydration_rhythm',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T053',
  updated_at = now()
WHERE topic_id = 'T053' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'nutrition_pattern',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T054',
  updated_at = now()
WHERE topic_id = 'T054' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'movement_style',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T055',
  updated_at = now()
WHERE topic_id = 'T055' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'mental_wellness_pattern',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T056',
  updated_at = now()
WHERE topic_id = 'T056' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'breathing_or_meditation_log',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T057',
  updated_at = now()
WHERE topic_id = 'T057' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'stress_insight',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T058',
  updated_at = now()
WHERE topic_id = 'T058' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'health_education',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T059',
  updated_at = now()
WHERE topic_id = 'T059' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'conditions_and_risks_boundaries',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T060',
  updated_at = now()
WHERE topic_id = 'T060' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'professional_or_support_boundary',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T061',
  updated_at = now()
WHERE topic_id = 'T061' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'biomarkers_preview',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T062',
  updated_at = now()
WHERE topic_id = 'T062' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'connected_apps',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T063',
  updated_at = now()
WHERE topic_id = 'T063' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'connect_later',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T064',
  updated_at = now()
WHERE topic_id = 'T064' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'health_plans',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T065',
  updated_at = now()
WHERE topic_id = 'T065' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'services_hub',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T066',
  updated_at = now()
WHERE topic_id = 'T066' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'plan_step',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T067',
  updated_at = now()
WHERE topic_id = 'T067' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'memory_overview',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T068',
  updated_at = now()
WHERE topic_id = 'T068' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'what_vitana_knows',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T069',
  updated_at = now()
WHERE topic_id = 'T069' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'thirteen_memory_categories',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T070',
  updated_at = now()
WHERE topic_id = 'T070' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'add_memory',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T071',
  updated_at = now()
WHERE topic_id = 'T071' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'memory_timeline',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T072',
  updated_at = now()
WHERE topic_id = 'T072' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'recall_memory',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T073',
  updated_at = now()
WHERE topic_id = 'T073' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'correct_memory',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T074',
  updated_at = now()
WHERE topic_id = 'T074' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'memory_permissions',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T075',
  updated_at = now()
WHERE topic_id = 'T075' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'data_export',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T076',
  updated_at = now()
WHERE topic_id = 'T076' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'diary_streak_and_rewards',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T077',
  updated_at = now()
WHERE topic_id = 'T077' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'photo_diary',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T078',
  updated_at = now()
WHERE topic_id = 'T078' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'pillar_lift_from_diary',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T079',
  updated_at = now()
WHERE topic_id = 'T079' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'calendar_agenda',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T080',
  updated_at = now()
WHERE topic_id = 'T080' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'create_calendar_event',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T081',
  updated_at = now()
WHERE topic_id = 'T081' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'reschedule_event',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T082',
  updated_at = now()
WHERE topic_id = 'T082' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'inbox_overview',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T083',
  updated_at = now()
WHERE topic_id = 'T083' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'inbox_tabs',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T084',
  updated_at = now()
WHERE topic_id = 'T084' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'draft_voice_note',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T085',
  updated_at = now()
WHERE topic_id = 'T085' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'community_hub',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T086',
  updated_at = now()
WHERE topic_id = 'T086' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'todays_highlights_and_rankings',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T087',
  updated_at = now()
WHERE topic_id = 'T087' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'global_and_community_search',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T088',
  updated_at = now()
WHERE topic_id = 'T088' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'feed_tabs',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T089',
  updated_at = now()
WHERE topic_id = 'T089' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'post_draft',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T090',
  updated_at = now()
WHERE topic_id = 'T090' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'react_safely',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T091',
  updated_at = now()
WHERE topic_id = 'T091' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'profile_preview',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T092',
  updated_at = now()
WHERE topic_id = 'T092' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'public_profile_visibility',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T093',
  updated_at = now()
WHERE topic_id = 'T093' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'qr_and_profile_sharing',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T094',
  updated_at = now()
WHERE topic_id = 'T094' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'find_a_match',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T095',
  updated_at = now()
WHERE topic_id = 'T095' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'match_types',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T096',
  updated_at = now()
WHERE topic_id = 'T096' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'why_this_match',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T097',
  updated_at = now()
WHERE topic_id = 'T097' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'match_list',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T098',
  updated_at = now()
WHERE topic_id = 'T098' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'search_matches',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T099',
  updated_at = now()
WHERE topic_id = 'T099' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'connect_or_dismiss',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T100',
  updated_at = now()
WHERE topic_id = 'T100' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'post_activity',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T101',
  updated_at = now()
WHERE topic_id = 'T101' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'seek_meetup',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T102',
  updated_at = now()
WHERE topic_id = 'T102' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'intent_matches',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T103',
  updated_at = now()
WHERE topic_id = 'T103' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'respond_match',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T104',
  updated_at = now()
WHERE topic_id = 'T104' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'share_intent',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T105',
  updated_at = now()
WHERE topic_id = 'T105' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'fulfill_intent',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T106',
  updated_at = now()
WHERE topic_id = 'T106' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'browse_groups',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T107',
  updated_at = now()
WHERE topic_id = 'T107' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'save_group',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T108',
  updated_at = now()
WHERE topic_id = 'T108' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'group_draft',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T109',
  updated_at = now()
WHERE topic_id = 'T109' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'group_detail',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T110',
  updated_at = now()
WHERE topic_id = 'T110' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'group_chat',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T111',
  updated_at = now()
WHERE topic_id = 'T111' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'invite_members',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T112',
  updated_at = now()
WHERE topic_id = 'T112' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'challenges',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T113',
  updated_at = now()
WHERE topic_id = 'T113' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'challenge_progress',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T114',
  updated_at = now()
WHERE topic_id = 'T114' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'share_achievement',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T115',
  updated_at = now()
WHERE topic_id = 'T115' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'events_search',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T116',
  updated_at = now()
WHERE topic_id = 'T116' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'event_filters',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T117',
  updated_at = now()
WHERE topic_id = 'T117' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'save_event',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T118',
  updated_at = now()
WHERE topic_id = 'T118' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'event_drawer',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T119',
  updated_at = now()
WHERE topic_id = 'T119' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'free_rsvp',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T120',
  updated_at = now()
WHERE topic_id = 'T120' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'ticket_safety',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T121',
  updated_at = now()
WHERE topic_id = 'T121' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'add_to_calendar',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T122',
  updated_at = now()
WHERE topic_id = 'T122' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'event_reminders',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T123',
  updated_at = now()
WHERE topic_id = 'T123' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'attendee_matching',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T124',
  updated_at = now()
WHERE topic_id = 'T124' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'create_event',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T125',
  updated_at = now()
WHERE topic_id = 'T125' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'event_basics',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T126',
  updated_at = now()
WHERE topic_id = 'T126' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'event_draft',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T127',
  updated_at = now()
WHERE topic_id = 'T127' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'create_meetup',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T128',
  updated_at = now()
WHERE topic_id = 'T128' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'activity_location_and_time',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T129',
  updated_at = now()
WHERE topic_id = 'T129' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'invite_members_to_meetup',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T130',
  updated_at = now()
WHERE topic_id = 'T130' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'meetup_drawer',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T131',
  updated_at = now()
WHERE topic_id = 'T131' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'local_meetup',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T132',
  updated_at = now()
WHERE topic_id = 'T132' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'meetup_changes',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T133',
  updated_at = now()
WHERE topic_id = 'T133' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'browse_live_rooms',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T134',
  updated_at = now()
WHERE topic_id = 'T134' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'join_listener',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T135',
  updated_at = now()
WHERE topic_id = 'T135' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'speak_or_chat',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T136',
  updated_at = now()
WHERE topic_id = 'T136' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'schedule_live_room',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T137',
  updated_at = now()
WHERE topic_id = 'T137' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'room_topic_and_description',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T138',
  updated_at = now()
WHERE topic_id = 'T138' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'go_live_safety',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T139',
  updated_at = now()
WHERE topic_id = 'T139' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'live_room_recordings',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T140',
  updated_at = now()
WHERE topic_id = 'T140' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'highlights_and_moments',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T141',
  updated_at = now()
WHERE topic_id = 'T141' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'room_summaries',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T142',
  updated_at = now()
WHERE topic_id = 'T142' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'media_hub_overview',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T143',
  updated_at = now()
WHERE topic_id = 'T143' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'watch_shorts',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T144',
  updated_at = now()
WHERE topic_id = 'T144' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'save_or_bookmark_media',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T145',
  updated_at = now()
WHERE topic_id = 'T145' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'play_podcasts',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T146',
  updated_at = now()
WHERE topic_id = 'T146' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'audio_bar',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T147',
  updated_at = now()
WHERE topic_id = 'T147' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'podcast_routine',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T148',
  updated_at = now()
WHERE topic_id = 'T148' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'play_music',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T149',
  updated_at = now()
WHERE topic_id = 'T149' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'focus_music',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T150',
  updated_at = now()
WHERE topic_id = 'T150' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'media_overlay',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T151',
  updated_at = now()
WHERE topic_id = 'T151' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'upload_short',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T152',
  updated_at = now()
WHERE topic_id = 'T152' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'upload_podcast',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T153',
  updated_at = now()
WHERE topic_id = 'T153' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'publishing_rights',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T154',
  updated_at = now()
WHERE topic_id = 'T154' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'community_recap',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T155',
  updated_at = now()
WHERE topic_id = 'T155' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'choose_next_social_action',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T156',
  updated_at = now()
WHERE topic_id = 'T156' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'community_trust_becomes_opportunity',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T157',
  updated_at = now()
WHERE topic_id = 'T157' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'path_choice',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T158',
  updated_at = now()
WHERE topic_id = 'T158' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'economy_positioning',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T159',
  updated_at = now()
WHERE topic_id = 'T159' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'business_interest',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T160',
  updated_at = now()
WHERE topic_id = 'T160' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'discover_overview',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T161',
  updated_at = now()
WHERE topic_id = 'T161' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'search_discover',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T162',
  updated_at = now()
WHERE topic_id = 'T162' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'why_recommended',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T163',
  updated_at = now()
WHERE topic_id = 'T163' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'supplements_and_products',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T164',
  updated_at = now()
WHERE topic_id = 'T164' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'product_detail_and_suitability',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T165',
  updated_at = now()
WHERE topic_id = 'T165' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'save_wishlist_or_cart',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T166',
  updated_at = now()
WHERE topic_id = 'T166' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'wellness_services',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T167',
  updated_at = now()
WHERE topic_id = 'T167' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'providers_doctors_and_coaches',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T168',
  updated_at = now()
WHERE topic_id = 'T168' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'provider_profile_trust',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T169',
  updated_at = now()
WHERE topic_id = 'T169' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'universal_cart',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T170',
  updated_at = now()
WHERE topic_id = 'T170' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'purchase_rules',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T171',
  updated_at = now()
WHERE topic_id = 'T171' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'refund_path',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T172',
  updated_at = now()
WHERE topic_id = 'T172' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'wallet_overview',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T173',
  updated_at = now()
WHERE topic_id = 'T173' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'credits_rewards_subscriptions',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T174',
  updated_at = now()
WHERE topic_id = 'T174' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'current_plan_and_billing',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T175',
  updated_at = now()
WHERE topic_id = 'T175' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'rewards_program',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T176',
  updated_at = now()
WHERE topic_id = 'T176' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'payment_methods',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T177',
  updated_at = now()
WHERE topic_id = 'T177' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'vitana_coin',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T178',
  updated_at = now()
WHERE topic_id = 'T178' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'sharing_overview',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T179',
  updated_at = now()
WHERE topic_id = 'T179' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'channel_connector',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T180',
  updated_at = now()
WHERE topic_id = 'T180' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'social_share_consent',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T181',
  updated_at = now()
WHERE topic_id = 'T181' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'campaign_basics',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T182',
  updated_at = now()
WHERE topic_id = 'T182' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'create_campaign_draft',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T183',
  updated_at = now()
WHERE topic_id = 'T183' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'distribution_and_schedule',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T184',
  updated_at = now()
WHERE topic_id = 'T184' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'sharing_analytics',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T185',
  updated_at = now()
WHERE topic_id = 'T185' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'posts_history',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T186',
  updated_at = now()
WHERE topic_id = 'T186' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'data_consent_audit',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T187',
  updated_at = now()
WHERE topic_id = 'T187' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'my_business_overview',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T188',
  updated_at = now()
WHERE topic_id = 'T188' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'business_path_check',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T189',
  updated_at = now()
WHERE topic_id = 'T189' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'skill_inventory',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T190',
  updated_at = now()
WHERE topic_id = 'T190' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'business_post',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T191',
  updated_at = now()
WHERE topic_id = 'T191' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'find_clients',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T192',
  updated_at = now()
WHERE topic_id = 'T192' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'match_list',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T193',
  updated_at = now()
WHERE topic_id = 'T193' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'event_asset',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T194',
  updated_at = now()
WHERE topic_id = 'T194' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'event_plan',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T195',
  updated_at = now()
WHERE topic_id = 'T195' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'ticket_sales',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T196',
  updated_at = now()
WHERE topic_id = 'T196' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'service_as_offer',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T197',
  updated_at = now()
WHERE topic_id = 'T197' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'outcome_audience_duration_price',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T198',
  updated_at = now()
WHERE topic_id = 'T198' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'service_draft',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T199',
  updated_at = now()
WHERE topic_id = 'T199' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'live_trust',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T200',
  updated_at = now()
WHERE topic_id = 'T200' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'business_live_room',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T201',
  updated_at = now()
WHERE topic_id = 'T201' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'invite_people',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T202',
  updated_at = now()
WHERE topic_id = 'T202' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'media_asset',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T203',
  updated_at = now()
WHERE topic_id = 'T203' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'content_plan',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T204',
  updated_at = now()
WHERE topic_id = 'T204' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'campaign_asset',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T205',
  updated_at = now()
WHERE topic_id = 'T205' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'fact_bank',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T206',
  updated_at = now()
WHERE topic_id = 'T206' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = '27t_economy',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T207',
  updated_at = now()
WHERE topic_id = 'T207' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'plain_summary',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T208',
  updated_at = now()
WHERE topic_id = 'T208' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'future_work',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T209',
  updated_at = now()
WHERE topic_id = 'T209' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'job_reshaping',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T210',
  updated_at = now()
WHERE topic_id = 'T210' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'ai_amplified_skill',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T211',
  updated_at = now()
WHERE topic_id = 'T211' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'market_size',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T212',
  updated_at = now()
WHERE topic_id = 'T212' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'wellness_economy',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T213',
  updated_at = now()
WHERE topic_id = 'T213' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'sector_fit',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T214',
  updated_at = now()
WHERE topic_id = 'T214' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'demographic_demand',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T215',
  updated_at = now()
WHERE topic_id = 'T215' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'aging_market',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T216',
  updated_at = now()
WHERE topic_id = 'T216' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'demand_fit',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T217',
  updated_at = now()
WHERE topic_id = 'T217' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'gig_proof',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T218',
  updated_at = now()
WHERE topic_id = 'T218' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'gig_economy',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T219',
  updated_at = now()
WHERE topic_id = 'T219' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'flexible_earning',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T220',
  updated_at = now()
WHERE topic_id = 'T220' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'offer_ladder',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T221',
  updated_at = now()
WHERE topic_id = 'T221' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'offer_types',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T222',
  updated_at = now()
WHERE topic_id = 'T222' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'first_offer',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T223',
  updated_at = now()
WHERE topic_id = 'T223' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'sell_and_earn_inventory',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T224',
  updated_at = now()
WHERE topic_id = 'T224' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'reseller_link',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T225',
  updated_at = now()
WHERE topic_id = 'T225' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'commission_tracking',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T226',
  updated_at = now()
WHERE topic_id = 'T226' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'promotion_channels',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T227',
  updated_at = now()
WHERE topic_id = 'T227' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'social_channels',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T228',
  updated_at = now()
WHERE topic_id = 'T228' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'share_copy',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T229',
  updated_at = now()
WHERE topic_id = 'T229' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'campaign_metrics',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T230',
  updated_at = now()
WHERE topic_id = 'T230' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'reach_clicks_engagement',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T231',
  updated_at = now()
WHERE topic_id = 'T231' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'improve_one_campaign',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T232',
  updated_at = now()
WHERE topic_id = 'T232' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'client_management',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T233',
  updated_at = now()
WHERE topic_id = 'T233' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'booking_calendar_follow_up',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T234',
  updated_at = now()
WHERE topic_id = 'T234' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'delivery_checklist',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T235',
  updated_at = now()
WHERE topic_id = 'T235' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'earnings_and_payouts',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T236',
  updated_at = now()
WHERE topic_id = 'T236' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'pending_available_history',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T237',
  updated_at = now()
WHERE topic_id = 'T237' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'withdrawal_readiness',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T238',
  updated_at = now()
WHERE topic_id = 'T238' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'marketplace_autopilot',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T239',
  updated_at = now()
WHERE topic_id = 'T239' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'opportunity_suggestions',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T240',
  updated_at = now()
WHERE topic_id = 'T240' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'review_why_and_permissions',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T241',
  updated_at = now()
WHERE topic_id = 'T241' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'responsible_recommendations',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T242',
  updated_at = now()
WHERE topic_id = 'T242' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'no_false_claims',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T243',
  updated_at = now()
WHERE topic_id = 'T243' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'trust_and_safety_checklist',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T244',
  updated_at = now()
WHERE topic_id = 'T244' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'seven_day_business_sprint',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T245',
  updated_at = now()
WHERE topic_id = 'T245' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'vitana_next_best_action',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T246',
  updated_at = now()
WHERE topic_id = 'T246' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'choose_sprint_metric',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T247',
  updated_at = now()
WHERE topic_id = 'T247' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'graduation',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T248',
  updated_at = now()
WHERE topic_id = 'T248' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'full_mode',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T249',
  updated_at = now()
WHERE topic_id = 'T249' AND guided_practice_target IS NULL;
UPDATE journey_checklist_topics SET
  guided_practice_target = 'next_milestone',
  practice_action_type = 'orb_explain',
  completion_event = 'topic_explained_T250',
  updated_at = now()
WHERE topic_id = 'T250' AND guided_practice_target IS NULL;

INSERT INTO journey_checklist_audit (action, detail) VALUES ('seed', 'VTID-03288 grounding: practice-loop fields for T011-T250');

COMMIT;
