# VTID-05023: migration order for the Aurora cutover (G)

Status: **pending owner O5.** The repo does not define a 12 or 13 file apply set, so this file gives the full candidate list. The owner confirms or cuts it.

## Result

- Candidate count: **732** (733 top-level files in `supabase/migrations/` minus the held drop). This is not a 12 or 13 file set.
- Excluded: **1** (`20261102052300_vtid_05573_legacy_messages_drop.sql`).
- Candidates flagged by the Aurora compatibility lint: **369 of 732**. These need the B2 fixes before they apply to Aurora unchanged. None of them is fixed in this file.
- Source: `origin/main` on `vitana/vitana-platform` (GitLab), commit `a02b8918f38a57f7b0b6910a365e2a70629d6b89`. The working tree at that commit matches the blobs, so the sha256 values below are blob content hashes.

## Why 732 is the candidate set, and why it is not yet an apply set

- The handover (`docs/handover/VTID-05023/KIRO-HANDOVER.md`, V7 and B2) says "12 or 13 files" and does not name them. The lane (`docs/validation/VTID-05023/lane.md` at `cutover/vtid-05023-lane`, B-O5) records the same gap. O5 is open.
- Searched the repo for a list: `docs/validation/VTID-05023/`, `scripts/aws/`, `docs/handover/` and `docs/` for "O5", "12 or 13", "apply set" and "migration list". No list exists.
- The Aurora target is a copy of an existing database, so it probably already holds the earlier migrations. This is an inference. The repo does not record the last migration applied to Aurora. Without that boundary, no cut below 732 can be derived from the repo, and applying all 732 to a database that already has the earlier schema would fail on objects that exist.
- The `supabase/migrations/data-fixups/` folder also has 12 files. It is a count match only. Those files sit outside the top-level path, and the Aurora apply path records only `supabase/migrations/<file>.sql` (`docs/validation/VTID-05123/acceptance.md`, AC-6). They are listed separately below and are not in the 732.

## Ordering rule

Filename order using the C (byte) locale sort: `LC_ALL=C sort`. The leading digits are the version, so this is timestamp order. Files with an 8-digit prefix (for example `20251027_oasis_events_v1.sql`) sort by those digits. Files that share a prefix sort by the rest of the name. Apply in index order, one file per call, and stop on the first error.

## Lint

`scripts/aws/aurora-compat-lint.mjs` is not on `origin/main`. It exists on branch `cutover/vtid-05023-gitlab-aurora-strip` (local commit `7e4468151a`, in the cutover workspace). This run used that file, copied to a path outside the repo. Its sha256 is `f8da2a66edffab0368cc46d4b3843a273f8e57be843104c60285701e866a47f3`. Rule set: `auth-schema`, `storage-schema`, `supabase-role`, `supabase-extension`. The lint output for every file is in the table. A `clean` result only means the four rules did not match. It does not prove the file applies on Aurora.

## Candidate list (732, apply in index order)

| Index | File | sha256 (origin/main blob) | Lint findings |
|---|---|---|---|
| 1 | `20251027_oasis_events_v1.sql` | 7664bc3619974f701bd1db78a37aa8fd00ab4d0aa4335169cc053a67fc7bcccf | clean |
| 2 | `20251120000000_init_governance.sql` | 4a0966af048247fe1c2764e2c68e2d6d90b556fdfe0b479a3e8c062c3e7b8bbb | supabase-role 10 |
| 3 | `20251120000001_add_migration_governance_rules.sql` | 2dc13d0b9aad21f091040040a354b1191ce2645fd168cd16f4c7a1d6f3222038 | clean |
| 4 | `20251120000002_init_governance_proposals.sql` | e575ffa541caedf0272df47bc388a311cdf80faaaf8c92fc5801bd50d722de5a | supabase-role 2 |
| 5 | `20251120171937_oasis_gov_0102.sql` | f7413b41f2d226ae94eb07c042bdfa68e55055b54b5cd1813e3e8826b3f4eee0 | clean |
| 6 | `20251120174934_validate_oasis_gov_0103.sql` | 256872a1b5c3e72584f803ac148e11ee55e5b2198bcde9e9b06420e47f6a770f | clean |
| 7 | `20251120232139_oasis_gov_0108_rules_seed_fixed.sql` | 90e4f58e83af7d3756c46bc6543a59aa68f147e4688f9da536837535ac1fac70 | clean |
| 8 | `20251128000001_software_versions.sql` | f16131fe1d5852d91db74c8d74429d556deae64ed1bdb9e1536e03b2f3051fb9 | auth-schema 1 |
| 9 | `20251203000000_governance_catalog_init.sql` | 6e32b2be4bb4ea90791041e51f860d2ff889039222461ea583e219094ee142f4 | supabase-role 2 |
| 10 | `20251203120000_fix_governance_rule_levels.sql` | f0c22c3b9da6167dcc8403e56039a53faf93bbfd7167deabeeb6f6b3026f0405 | clean |
| 11 | `20251207000000_fix_governance_rules_rule_id_constraint.sql` | 4becf9e1f0a6c9097fc89c6b399c9916603a7de192ae5a49fbb3f49ecd6ebbff | clean |
| 12 | `20251209000000_add_task_stage.sql` | 53f03812909420742fb9a2a71061a9df7c21ffd29b88b7023f1fb29f996d48ce | supabase-role 4 |
| 13 | `20251213000000_knowledge_docs.sql` | 2d4e9086e9051aead281ae41a88817685e21104211b3db1db9d9f32516c484fc | supabase-role 5 |
| 14 | `20251217000000_vtid_ledger_and_allocator.sql` | 9afe19d8a6fab3385adcb89ddfdce59c052c5c264b8f4447e2ddd2991316598d | supabase-role 8 |
| 15 | `20251218000000_vtid_0543_atomic_create.sql` | c63fc46003d889eb49287b4e04ec949b620c3686a97ec8ff25351435399adbee | supabase-role 2 |
| 16 | `20251228000000_vtid_01050_dev_bootstrap_context.sql` | 74ca6977c3038adb0ea9394977ecb1d2330addd2e9de9b6f3885e17b7918499a | supabase-role 1 |
| 17 | `20251229000000_vtid_01051_me_active_role_fix.sql` | e9a14a15ec2228e11adea076d7e7dbf456853a266cc4b3d3af81bc733fd27cfe | supabase-role 4; auth-schema 6 |
| 18 | `20251229000000_vtid_01052_soft_delete.sql` | 6dc618aabf405a375f9b1bf5d9950587ac9fa99d8a03137c6d6349f203540fa3 | clean |
| 19 | `20251230000000_vtid_01080_terminal_completion.sql` | 604fe291f56c5503163d293d853ad20af5040936e404549e857f2f92efbfb4e0 | clean |
| 20 | `20251231000000_vtid_01078_health_brain_phase_c1.sql` | 48aa29ae7b2eb8b77324a6b07b2f1e374e902cb02c5e104186215e50e32d6aa4 | supabase-role 4; auth-schema 1 |
| 21 | `20251231000000_vtid_01101_phase_a_bootstrap.sql` | 4607bb9e1209cafbc95fbd9f17e94e3b1fd2c02957fe453af2a3cb9fd1180c9b | auth-schema 5; supabase-role 10 |
| 22 | `20251231000000_vtid_01103_health_compute_engine.sql` | 75c835e2ef297d8fce4cc5198e8c8477e42175f286b161167a8971de8a946a5a | supabase-role 8; auth-schema 13 |
| 23 | `20251231000000_vtid_01104_memory_core_v1.sql` | e01fa1c226d0f210582838665270babd69bf4b3ac8cfe56ccf18ec1964b90139 | supabase-role 9; auth-schema 7 |
| 24 | `20251231000001_vtid_01083_longevity_signal_layer.sql` | 5f2e4b45d56630e4c24f36abcec9d2eb31c92ea1d815b99aefeb761480ef4a9e | supabase-role 9; auth-schema 7 |
| 25 | `20251231000001_vtid_01085_memory_retrieve_router.sql` | fb310cb16a74196526c0a5f737cc7dc598efc3f052d896f9c75a45c72cf3aec6 | supabase-role 13; auth-schema 11 |
| 26 | `20251231000001_vtid_01086_memory_garden_progress.sql` | e432e545837e7b1d56fc6a4ba9d8fc4db8e36caed2448dd93a478b33c765d677 | auth-schema 1; supabase-role 5 |
| 27 | `20251231000001_vtid_01087_relationship_graph_memory.sql` | d98d8c81044e22ae7059a9277d8edb10be4b215150cc95a598149d9cdac33285 | auth-schema 14; supabase-role 23 |
| 28 | `20251231000001_vtid_01088_matchmaking_engine.sql` | 80295a9c3b06dbc4e38b7a0e654e209e8199ec71f0170f593acddbe77c1a8ba2 | supabase-role 19; auth-schema 7 |
| 29 | `20251231000001_vtid_01089_autopilot_prompts.sql` | ef7bda945377f0d4aaf5fb7ebe3d17eecaf9ab911cb096760ac6371101f92bbd | supabase-role 13; auth-schema 5 |
| 30 | `20251231000001_vtid_01090_live_rooms_events_graph.sql` | 0472effdf289f8e138121af1396b09e178295ed83610adb17a805f70164e010e | supabase-role 45 |
| 31 | `20251231000001_vtid_01091_locations_memory_graph.sql` | 906127d9f1d5489b1ad738eb2d64b4b3200ff642b02bcfa6a3b1fd52726d9ca5 | supabase-role 25; auth-schema 27 |
| 32 | `20251231000001_vtid_01093_topics_layer.sql` | be8bca9531c870ad7cf8e8c5e4442dc03fd13cc687f823b27ac97c85eef15e17 | supabase-role 16; auth-schema 7 |
| 33 | `20251231000001_vtid_01094_match_feedback_loop.sql` | b0ed96464c1da0edd44dd08ba9adbc827a7bda4889c221d96e5e1df06d82c933 | supabase-role 48 |
| 34 | `20251231000001_vtid_01095_daily_scheduler.sql` | b0fe7902642a6696b9e13b6f512130741fae3aea57c9b3b4777efd5a8a576982 | supabase-role 7; auth-schema 2 |
| 35 | `20251231000001_vtid_01098_memory_timeline_causality.sql` | 69dfda96cbc4dbcd9c87b94383f03393d8ce232494043caa35bb16a420906ebc | auth-schema 7; supabase-role 7 |
| 36 | `20251231100000_vtid_01082_memory_garden_diary.sql` | a017bb4107ca8b633711032f83af70a87d9d42f8c45a22c1a98508943b4e7124 | supabase-role 19; auth-schema 17 |
| 37 | `20251231100000_vtid_01084_community_personalization_v1.sql` | 57664675da3b1af974ab16fc2b7ea79adf9cdf1e4d7ab999072cc3098c9c6811 | supabase-role 27; auth-schema 14 |
| 38 | `20251231100000_vtid_01092_services_products_memory.sql` | 69c1360ec8aca1353bd3892855c30d00f96913c00ed043cb5fdedfe96db64db5 | auth-schema 10; supabase-role 19 |
| 39 | `20251231100000_vtid_01099_memory_governance_v1.sql` | 44bdbf1571d286cb42c22bb03f9de011b5713b0f27ec0e2dd7ac57a8b03e5233 | auth-schema 26; supabase-role 27 |
| 40 | `20251231100000_vtid_01100_memory_quality_metrics.sql` | eeb7aad5cad78f21551c250a9e40c1416625e7df45d4043ea4c171d932901a12 | auth-schema 6; supabase-role 6 |
| 41 | `20260101000000_vtid_01116_memory_confidence_trust_engine.sql` | 96d4b8511cfcbad2d9d8e4ae6742cb06f24ca4252b3a9c586497a3685fb38eba | supabase-role 16; auth-schema 6 |
| 42 | `20260102000000_vtid_01112_context_assembly_engine.sql` | 82d9679cd257c6e3822827245928d4a73e3d15d2528de5cc5733d4e7f71833c7 | supabase-role 7; auth-schema 3 |
| 43 | `20260102000000_vtid_01117_context_window_metrics.sql` | 45dc087d453be2aeaa22036098749b61dca89ec5b98144c0466af3c07527ebc3 | auth-schema 1; supabase-role 8 |
| 44 | `20260102000000_vtid_01120_emotional_cognitive_signals.sql` | 6d703861c1b77b66b7f66e248dc20df447acd5aa28e9bdcbd271564df1e6f6bd | supabase-role 10; auth-schema 8 |
| 45 | `20260102000000_vtid_01121_feedback_trust_repair.sql` | 915d13224bd0a2393cd20128ad1bf60a6bdd32a94a2a561b1fde0348ad69ac22 | supabase-role 39 |
| 46 | `20260102000000_vtid_01136_context_fusion_engine.sql` | ecd6f8c4f22839b9f220ec6741a11983b4cdd71218a33df4a694f691d17d2cb9 | auth-schema 12; supabase-role 16 |
| 47 | `20260102000001_vtid_01129_social_context_relationships.sql` | eba36bd74841d8c79b78cc4a42da9f9b19834aa8808c68183708a9b58885e6ec | supabase-role 23; auth-schema 18 |
| 48 | `20260102100000_vtid_01119_user_preference_modeling_v1.sql` | 1cab8e06079eca4d59ede116655e66305a597aa64690bb62d1832d5b14d53a20 | auth-schema 30; supabase-role 33 |
| 49 | `20260102100000_vtid_01124_life_stage_awareness.sql` | 090bcae4f1cff2e19b164c68e4001017a7968721e94832e3ed3c57196da88e37 | auth-schema 12; supabase-role 16 |
| 50 | `20260102110000_vtid_01133_taste_alignment_engine_v1.sql` | bb6b47fd657d96178ef8a024f873b34138b48206d3c51146be5fafb99e4df0d3 | auth-schema 25; supabase-role 28 |
| 51 | `20260102200000_vtid_01122_health_capacity_awareness.sql` | 7f244ff8919ceda761205d418399175efaa9222f52516c84f11c513832e0b115 | supabase-role 14; auth-schema 10 |
| 52 | `20260102200000_vtid_01127_availability_readiness_engine.sql` | bdb3a15d6cf53b65b61efb7f3b34e1ce151e21e71a1c458b791b5f01639fd46a | supabase-role 9; auth-schema 13 |
| 53 | `20260102200000_vtid_01130_financial_monetization_engine.sql` | c27896ece87349b8b9beb3cddc5a9492711f8cb6d17769f9dd507035d260fffa | auth-schema 25; supabase-role 29 |
| 54 | `20260103000000_vtid_01145_overload_detection.sql` | 5ad8fd0572f71c6d7fd13e5d4ae74bd77d2501014d6eda6fb56cbd9753df237a | supabase-role 19; auth-schema 19 |
| 55 | `20260103000001_vtid_01141_d47_social_alignment_engine.sql` | f0f1bb437cd49635d103c82bb07d7594646e767339b99c2c396222d73e3515e4 | supabase-role 19; auth-schema 11 |
| 56 | `20260105_vtid_01146_d46_anticipatory_guidance.sql` | c633b91860aaad1b101d1daeb2281ac095b5b2077022f88cc3dc9d72df2ad4e5 | auth-schema 3; supabase-role 6 |
| 57 | `20260106000000_add_oasis_only_task_truth_rule.sql` | ca4ac62e9866fed936cd731c9197645a53fff5fcde1ceccf5ccc5b3dac6a468d | clean |
| 58 | `20260108000000_vtid_debug_memory_retention_fix.sql` | bba070f62d0581044daf876bae550a72004a4e035bccb15f01c87367934a4d79 | clean |
| 59 | `20260116000000_vtid_01179_autopilot_event_loop.sql` | 3403ed1d3b5b28a97b2b2e1e120fd05afdc0fbe23e983afb0d82aebed8be35fc | supabase-role 7 |
| 60 | `20260117000000_vtid_01183_worker_agent_connector.sql` | fdd14a31f22a3005434558763f9540272a0634d77347a71f8c975b6736ff8b54 | auth-schema 1; supabase-role 7 |
| 61 | `20260117100000_vtid_01180_recommendation_inbox.sql` | 327b3db28a95d47f33a4fbe5df2c7169c15bf09a8ef18b065b34e52035024197 | supabase-role 17; auth-schema 2 |
| 62 | `20260117120000_vtid_01180_autopilot_recommendations.sql` | f38617adf45b9c9decd604df270539e87e9dd2b7988acf839e9622c261aec3e2 | auth-schema 2; supabase-role 13 |
| 63 | `20260117130000_vtid_01185_recommendation_engine.sql` | 8233a810ab05f91b3d1e7bdc078f15005f768abb763c181902d0feb78d25dd92 | supabase-role 17 |
| 64 | `20260117140000_vtid_01184_pgvector_semantic_memory.sql` | c1022e24db6c47300e2c9fc75f6c58019b01664f2ffedc2d5217b180bcef1286 | supabase-role 5; auth-schema 2 |
| 65 | `20260117150000_vtid_01181_governance_controls.sql` | 519b6790d9daabafe173ed19da049fbef10acb27ca7cda399e650b0e76d150c6 | supabase-role 4 |
| 66 | `20260119000000_vtid_01188_unified_spec_generation.sql` | eb810f213d366dfb0d2fe383f54941288617d447edd39fae178b57d89b8b3513 | supabase-role 13 |
| 67 | `20260119000000_vtid_01190_persistent_vtid_specs.sql` | f9b0a956b835b5b0a2aabe3e7e6ac873772695f4947d1ed68de781d7f141446e | supabase-role 6 |
| 68 | `20260119000000_vtid_01192_infinite_memory_v2.sql` | a06b32b807ff6b1831e6858cf4ee2686a1c9af53162f1caee09dc5cd4c42f1a4 | supabase-role 8 |
| 69 | `20260119100000_vtid_01186_profile_avatar.sql` | b936f81a7b19b590615e3318fcd21607116ab9b9bbde9b3f0de9f125c32f566c | auth-schema 2; supabase-role 3 |
| 70 | `20260119100000_vtid_01194_execution_trigger_semantics.sql` | 9cadba265c5a2448bce0630eaf06058af62957b76d9e4e2c9e2c4e4bcbac18ca | clean |
| 71 | `20260121000000_vtid_01201_claim_scheduled_tasks.sql` | b69f78f1fc5298c224bf53da159d1172c4aa4aeeae8276c0da76fe0be1f95bd0 | clean |
| 72 | `20260123000000_vtid_01208_llm_routing_policy.sql` | 6a1b187b3c088933b881f364353412d7d4607f80186962b6526dd1cb6dcc25b9 | supabase-role 10 |
| 73 | `20260201000000_vtid_01225_cognee_extractor.sql` | fa7c57acfcfc80f38a804b0b165b10236ef0433b6d193b28e9b764e4e3129fa7 | auth-schema 2; supabase-role 5 |
| 74 | `20260203000000_vtid_01225_extend_memory_category_mapping.sql` | fd7d99ca2db846b1b4a0791df709d838367ee673e40671ef2b8a606b688cc5c0 | clean |
| 75 | `20260203000001_vtid_01225_rpc_service_role_grants.sql` | 584d614d2fd419fb3abbf36e426c5b5cc65b680f47bbf78c2600d1eb78ecf26d | supabase-role 1 |
| 76 | `20260205000000_fix_oasis_events_disk_io_indexes.sql` | 05129fe4195145aa5fdae5cc784431724768eb208653a0addeee5194d7a52a28 | supabase-role 1 |
| 77 | `20260209_vtid_01228_daily_co_live_rooms.sql` | 47244b5ff35cef2dc38c279ccd71728f71042f5cdcd6db8479d28a6a51b20977 | auth-schema 4 |
| 78 | `20260209_vtid_01228_daily_co_live_rooms_down.sql` | 4a29881c90139a7da107d75ec4b98aedc73b85c5bb07222a7efaf55f3994e1d9 | clean |
| 79 | `20260209_vtid_01228_daily_co_live_rooms_fixed.sql` | 80024b13250c7b08d21f6732c77ba5a2d782746d4fd4058da65da3dc02c8d3df | auth-schema 4 |
| 80 | `20260209_vtid_01231_stripe_connect.sql` | 02fd394916ae558d0d41b87153224d99c2b81c0766cfd0d7cc4b2d551d79a4fc | auth-schema 2 |
| 81 | `20260210000000_vtid_01090_fix_live_room_creation.sql` | 57f977447deb8b2d0c1348c84b6624803a06dd5994f8efd2ef0098dd39398cbd | supabase-role 2 |
| 82 | `20260210100000_vtid_01228_live_room_session_mgmt.sql` | a11c2a4ee2bc6ce36a3713d0d8c41f13998388301efaa703a85f0e6139429a45 | auth-schema 15 |
| 83 | `20260211000000_fix_live_room_create_for_permanent_rooms.sql` | 45bcae4c4c18d6a354a687d6cdff04cc9b851f927b55d1d9d44c0cb5960a1545 | clean |
| 84 | `20260214000000_oasis_actor_surface_tracking.sql` | 3cfdb43e8b102b67e7306de2b2cc80a12a2b8cbdea99bccf7a9ade736d256c51 | clean |
| 85 | `20260215000000_cleanup_stuck_live_sessions.sql` | 38fb275f55edf60f7e10cb250fd5fdf1e685f239035e895bea83c7764823c1bb | clean |
| 86 | `20260216000000_security_linter_fixes.sql` | f17414544723ecbb122963ee83fe260699756f65877485244461bb5901a24c55 | clean |
| 87 | `20260217000000_fix_write_fact_fk_order.sql` | 5ed56cac6470628c47519e4d6e7ada242b220cbc359a5408da106f53da87de54 | clean |
| 88 | `20260218000000_fix_maxina_signup_tenant_association.sql` | 9f083f855ca23b4818a19158b1e2ffb4a8f43f861f068c9729b343805b54f911 | supabase-role 2; auth-schema 5 |
| 89 | `20260220000000_write_fact_integrity_fixes.sql` | 12cfd5e6e0394e44887faa56317d06fd9c6b5c0270907a5e9ad594c8cc6b66bc | clean |
| 90 | `20260220000001_memory_facts_embedding_support.sql` | f57ff742c4f7242fe8e44e76e26c1184f958b1f41cfb78b71b967c710baeb934 | supabase-role 2 |
| 91 | `20260221000000_fix_embedding_dimensions_768.sql` | 6359c00192e7b8cb4289373ffb86b68926d7c609d84e7b41f384ada8aa0ca2d0 | supabase-role 3 |
| 92 | `20260225000000_notification_system.sql` | 9cf51f84f6bbe01178d237a630e8d008a1d807948ac59cc9da63a2dcfbfe2f6d | auth-schema 5 |
| 93 | `20260225100000_notification_system_v2.sql` | 2d1813217985b1424a7a21677be0ca421ed1138670b3e0825e0202a4f863b4a2 | clean |
| 94 | `20260225200000_chat_messages.sql` | 0fceb3fc59bdd2c420085b2bc0340ebc868559fae3cb154a257791784cadbede | auth-schema 5 |
| 95 | `20260225200000_notification_db_triggers.sql` | 8d9d203c8397bb57e2e84254107ca1b02ab5b8a2c76685a71bd1c553be770b09 | clean |
| 96 | `20260225300000_chat_and_invite_notifications.sql` | d89a129b2d006f9c26f3d701786a6a2fe36074b4136031cdd5b3ad9f48e32215 | auth-schema 4 |
| 97 | `20260225400000_push_dispatch_column.sql` | b102659f217c5cbdfc3865574946819d5333ea291968b5030197fa476809a91c | clean |
| 98 | `20260226000000_conversation_messages.sql` | ed9651c0713d801d10c85c2523fe89ad65709a24bef4ccb3a20f529046f89ab9 | auth-schema 2 |
| 99 | `20260226000000_signup_funnel_tracking.sql` | 38b52cc203855775d235459a524d8b84e77fdcf1f45e6c4fdbca49b54b5e525c | auth-schema 3; supabase-role 2 |
| 100 | `20260226100000_backfill_app_users_from_auth.sql` | ceb6a3ec9f2360b27e5bd5a2aa20f20a0ff6f39efa231e73b37eb8ee730fc1d9 | auth-schema 2 |
| 101 | `20260227000000_admin_rls_policies.sql` | a7bdc80cd6acc78dffe73860f6169c262d5f7c50533525c8870b850a353aac4b | supabase-role 19; auth-schema 19 |
| 102 | `20260227100000_user_feedback_reports.sql` | d4fc563249f158f860b517b536d6a651ef17a8b367e5b32672e1ecf8debbdf24 | auth-schema 4 |
| 103 | `20260310000000_fix_memory_tenant_resolution.sql` | 4e6ff624d46e1bd783c859f673f69985109eb1f8cf75b3cb45d0765354ce7a72 | auth-schema 4 |
| 104 | `20260312000000_chat_conversations_rpc.sql` | c6a01d549117b35d8931f0419047cb8f73dc3211c8289c360c05d6db1fe75f97 | supabase-role 2 |
| 105 | `20260315000000_chat_messages_type_metadata.sql` | 7533a2000b4f62af1d0cc036e2c906d997266ad8c7102d91ea892cc168d06281 | clean |
| 106 | `20260315000001_vitana_bot_user.sql` | 4c131ce18c732a6fc77d75354556fe0199bcf8474f2f24b0d969ed4c13c59c58 | auth-schema 1 |
| 107 | `20260315000002_rpc_add_message_type.sql` | e8a979699f016c89e66384603e19fdbbbbc97f854a673828e478e68c2fe157e1 | supabase-role 2 |
| 108 | `20260317000000_openclaw_bridge_tables.sql` | 32fbc03b1a990c265b60d2b87d8fc9b1acf22f6a059775613eeac04570d824d6 | clean |
| 109 | `20260318000000_fix_activate_recommendation_on_conflict.sql` | 2baabc7f6f548a106164861e7ba1f819b5e49bd340eaf074ad484ae23a1f1e19 | clean |
| 110 | `20260318000000_vtid_01250_autopilot_automations_engine.sql` | 244d71201d287c993fb84c8a49b1c5c734b605e4948d356302f79d91163df54f | auth-schema 5 |
| 111 | `20260318100000_role_admission_system.sql` | 79b3715b92001d4b2986ddc06a110f67d4adf81ae4eae91db24218a8ab1f4db3 | supabase-role 7; auth-schema 11 |
| 112 | `20260318100000_spec_quality_reports.sql` | 125db8397b29562ec95ba733386e9248350ad6b45b7fe14e9ac533f978384fb2 | clean |
| 113 | `20260318110000_spec_quality_status_values.sql` | 5901ed11716ef266de3ea7090f0a5848a04221b28bca41bb7541e95fcd6d4ba3 | clean |
| 114 | `20260321000000_community_user_analyzer.sql` | f957c08f9f9cfafcb91868c6986f83b8ecfada36291a466d5b25acb5f3dbe07e | clean |
| 115 | `20260321000000_fix_recommendation_vtid_format.sql` | a177b7b9c6d27011c88ebdc9e350356b23c401cb780fb02e34d99a93114a1f88 | clean |
| 116 | `20260322000000_vtid_task_retry_lifecycle.sql` | 5f586cbbf88d9da0136786d95b714c5463dbfe112ce851ea0717fcd9f1764dbd | clean |
| 117 | `20260322100000_fix_activate_recommendation_sha256.sql` | 05c04272dabc03215c3a92303f6dae325e2b0356d5d03ac22bd7a375e59e6b76 | clean |
| 118 | `20260324000000_testing_qa_tables.sql` | 434d263200abd64bdd9ec29d19f3a7a00b990de6f0b08ed9103bd5ceee8def1d | clean |
| 119 | `20260327000000_vtid_01250_social_connections.sql` | 1f00fffec56985605b22fe69f47ee1dd3a3c2437c9efb793bdf3fa60b3dd1988 | auth-schema 6 |
| 120 | `20260402000000_self_healing_tables.sql` | 883adf372cad42fb089815d3b03651a34be1897e0ee3f5cec7a24752312bfe03 | auth-schema 3 |
| 121 | `20260402100000_welcome_chat_sent_column.sql` | d0fb8947e83b97aac1e5ffd147c1498d71d9629e33c5455b3cd8f1353ad86af8 | clean |
| 122 | `20260409000000_add_avatar_position_offsets.sql` | a9408ef776a9f9edc23d204e1358bd98af158e35d29c8bce98970fdcdafa9620 | auth-schema 2 |
| 123 | `20260410000000_agents_registry.sql` | f170d994bf15f0f9bc896c8fa3559d601c76a8c49097c3b2e1485a574946acf7 | supabase-role 1; auth-schema 1 |
| 124 | `20260411000000_nav_catalog.sql` | ce760be739a60b936d3e104b91fc493a92a3e0b7a39cbe10ff113752e60f26e3 | auth-schema 3; supabase-role 3 |
| 125 | `20260411000100_nav_catalog_seed.sql` | 9f9559790a23a0c72c715188754ddd00ab5bd242d81e96ded946eec95657ade2 | clean |
| 126 | `20260412000000_tenant_invitations.sql` | 22e7016f5c1b24da4b5446709a8624c7dd1a25c391a5641d3feceb1c890b9197 | supabase-role 3; auth-schema 5 |
| 127 | `20260412100000_tenant_autopilot_config.sql` | ae7f2488cea9a86738dcc6d7a11e52948a3ce1d62537a9965eced87858a25126 | supabase-role 6; auth-schema 3 |
| 128 | `20260412120000_verify_autopilot_tables.sql` | 8bec277a7f4efe581f7f65a4b3d3b5425e44c9e4e1634d6b333b9703ff637f12 | clean |
| 129 | `20260412130000_create_autopilot_tables_debug.sql` | 0b4995210767068596794e5f011dc4e13b46aea2dd1a77c8e93ea040d41ab88f | clean |
| 130 | `20260412140000_check_tenants_schema.sql` | 84389aa11a0593cacc7656e998f1be44ca73ebfee14c22f17d0129fcbb398b87 | clean |
| 131 | `20260412150000_create_autopilot_tables_fixed.sql` | 0b419502ac75692d69fb499d7607fe21bb9dfefa2c0e14c6f940304c4c0ad1cb | auth-schema 3; supabase-role 6 |
| 132 | `20260412160000_check_autopilot_actions.sql` | b56ef874e39e028088ddcfde3f4c4e3aa07942f0816a0e0477425b9f86e3e52e | clean |
| 133 | `20260412200000_tenant_assistant_config.sql` | 3f97bbf53c4723b75cf9a2f5740d3e31d3d9a6b6d3a7221558817edb4ed7fffb | supabase-role 8; auth-schema 10 |
| 134 | `20260412300000_tenant_settings.sql` | fbe3e9aa9994148aed9e84fae7d834525e5d0d8b588985136223ae3e91ed6e46 | supabase-role 4; auth-schema 4 |
| 135 | `20260412400000_seed_maxina_settings.sql` | 1340bd3a00d989b696c15810f17261a94962d5b423b615213c71664a8fbfe630 | clean |
| 136 | `20260412500000_fix_maxina_settings_seed.sql` | 1f5942fea5b35b0351681c94bf594fcb5f2e5ee00cc630dc30af5f582d8d0b07 | clean |
| 137 | `20260412600000_fix_admin_tables.sql` | 3bc2070c6c60b6fa9861d8c6c98c81bd530cfd5f38747013d0f66355494ef254 | supabase-role 6 |
| 138 | `20260412700000_content_moderation.sql` | 24db065f38b3e8ed00ed21656dfc35b79e3e954e4ff50d4c18f7c5fce717402a | auth-schema 5; supabase-role 3 |
| 139 | `20260413000000_autopilot_wave_config.sql` | 9339e7144401843084a0f4ae71abb88283e711effa3aef4930e630ee6e59e449 | clean |
| 140 | `20260413000000_fix_claim_accepts_scheduled.sql` | ebbaa952d7ad150c086d70475fde76101472d5cfc7ebdc744083bbe36af3bf48 | clean |
| 141 | `20260413000000_intelligent_calendar.sql` | da1bc05b733d851996735e5b5bfb903bc17246eea68714d86270b827a2fccd95 | clean |
| 142 | `20260415000000_vtid_01900_longevity_news_feed.sql` | 35c8ccf27fce610688b78ab2dec1392e9b82331d0765d2a071867abdb2162378 | clean |
| 143 | `20260415100000_vtid_01900_news_items_image_url.sql` | 37d1c843751e0fd16ece6deb7ccc2c14504d4205dabee49cd10160be7bb45a29 | clean |
| 144 | `20260415200000_vtid_01900_news_items_language.sql` | bef7b72a349ea58c0726122838e24fdb084c68ac850282b7ba55afe77edb0c98 | clean |
| 145 | `20260416000000_notification_categories.sql` | 5011e917e3bad28168ad878c9b6d4ffae620d0cc55a154658c832d508ffe0bf6 | supabase-role 1; auth-schema 1 |
| 146 | `20260416000100_notification_categories_seed.sql` | 1548ba8ae77b0f43518dff9a3693d938c8184636f5265613d18e3993d04a5124 | clean |
| 147 | `20260416100000_dev_autopilot.sql` | dd72424c49ca09fe71788fef939d420558596eaa0e052d03ee9b272d0211c8d9 | supabase-role 5 |
| 148 | `20260416120000_vtid_02000_marketplace_foundation.sql` | 117ca5734f44522dedca051f504707815193cd5b32c56e8df9a08018c606d889 | auth-schema 10; supabase-role 50 |
| 149 | `20260416120100_vtid_02000_marketplace_seed.sql` | 2fd65f19257057680035b8a52bf8492a3fe1a6d945e9f7ce6e75cdb7fb2ea01b | clean |
| 150 | `20260416120200_vtid_02000_marketplace_helpers.sql` | 7e826c293e5c7589a1336901b1ecd7e7fa98c710a5a0ce7f79ae78d06bff1541 | supabase-role 4 |
| 151 | `20260416130000_vtid_02000_register_ledger.sql` | 31e59fe0c1904d40f252a26fffd517a42a64689e8d6b4f209f0415996530b43b | clean |
| 152 | `20260416140000_vtid_02000_pgrst_reload.sql` | bfaebfbae1b728abce934d98b74e64d42d8126b49307a4e53d9535eb4745f65d | clean |
| 153 | `20260416150000_nav_catalog_my_journey_news.sql` | db796fd92aa04f8508d666d92e706cc48afa85f76ff434aaf57c78cf030001c1 | clean |
| 154 | `20260416150000_vtid_02000_debug_products.sql` | b9bd4de61534659739e678bd93b9a8edcc437bc7b1ce5d442e182f3135928ade | supabase-role 2 |
| 155 | `20260416160000_nav_catalog_home_news_by_screen_id.sql` | 5c3ee3269abe571cc178a00de53fb312f93d656e004c79627c4b80f16fc5e2f4 | clean |
| 156 | `20260416160000_vtid_02000_inspect_state.sql` | d87eff854e9650fb86fee5414c6085d70e6b7c57596216c7d84354ee0750a026 | clean |
| 157 | `20260416170000_vtid_02000_fix_products.sql` | 6eda5e761c0288f0f7dd238071ef1d7ecdfb81dcdeca9ebfd61a0e54aeca96bb | supabase-role 14; auth-schema 4 |
| 158 | `20260416180000_nav_catalog_seed_fixed.sql` | 0472233d980bf5ca63230748378054fbb4df3ccfe0ced26c68818ce14c3778d1 | clean |
| 159 | `20260416180000_vtid_02000_fix_products_v2.sql` | 251221b176b302b7479b0196755e0fa51f157cefa4bfcde52613a6c2353699d7 | supabase-role 14; auth-schema 4 |
| 160 | `20260416200000_vtid_02000_seed_demo_catalog.sql` | 8bfc91b18e4bb039738316b44d9305ad1158c165137bfa185af59a3f5c05d531 | clean |
| 161 | `20260416200100_nav_autopilot_priority_down.sql` | d9f0ce3db1792aeb6fd31a44034b57f9c27fadf2f10d35e26f30b0dd6f3ae709 | clean |
| 162 | `20260417000000_vtid_02100_connector_framework.sql` | b00cc8f4bd402394b60f092b17ba75b6a7e5b3af048ac5fd303481491fb53783 | auth-schema 6; supabase-role 16 |
| 163 | `20260417000100_vtid_02100_connector_registry_seed.sql` | f9d231880b85d94a308bb56c7a355df4c9d3aa244488a603eb7cd38517b41448 | clean |
| 164 | `20260417000200_vtid_02100_register_ledger.sql` | 8a3fff1edd9ec726e580f4b01430b4c2bfa019bf27f884a694403f3a5c998f05 | clean |
| 165 | `20260417010000_vtid_02100_connector_registry_update.sql` | 9a3f84d975c285897855de913483af2773315f2bb926388d4e9893efe8cee589 | clean |
| 166 | `20260418000000_proactive_guide_phase0.sql` | e7f22c85d9378af8cfa9794d5f992345d216ef88992cb610563ddb603bc14d9a | auth-schema 15 |
| 167 | `20260418000000_vtid_02200_marketplace_sources_config.sql` | 07d6ebc96a4c4e716ba3c8d749a81f214976dfa7f727c3d1bb7936ba0901f214 | supabase-role 1 |
| 168 | `20260418000100_vtid_02200_register_ledger.sql` | f850e7f75ece060b59efa70771d7899d7e2b2644280c3fadcf1da952adaf3179 | clean |
| 169 | `20260418010000_vtid_02200_seed_shopify_demo.sql` | 2a90eedb09e256219f28626352dfb71e77618e72bbea6004014b51848eafae41 | clean |
| 170 | `20260418020000_vtid_02300_outbound_actions.sql` | 9cf49fa04f8dd55d1ef2fff41ccd314b8bb98cb29aac2578b10d9477fd7da7bc | auth-schema 6; supabase-role 11 |
| 171 | `20260418030000_vtid_02000_backfill_demo_images_descriptions.sql` | 214962ae5e908bb40690c1011d6b2e3699412679adde674e1391f1d58e039107 | clean |
| 172 | `20260418030000_vtid_02400_vaea_phase0.sql` | caca0efdeb20fb24f46b9a0fd2aa12287a558aedbc295cc0aa8e13dd1a7379ea | supabase-role 8; auth-schema 6 |
| 173 | `20260418040000_vtid_02000_product_detail_columns.sql` | c0b85f8e815ee6c671721f7409ac8b2962a02058a9c324c8b120ff4ff08f45f2 | clean |
| 174 | `20260418040000_vtid_02401_vaea_phase1_observe.sql` | 37be1778065624f53436d990fbcb3522b6e148c0f656a5a0f8d43ab91293476b | supabase-role 10; auth-schema 6 |
| 175 | `20260418050000_vtid_02000_description_long.sql` | f465635ffeb90a743ae4f9325714e08832f61c13e6d885aab126412ab00f8626 | clean |
| 176 | `20260418050000_vtid_02402_vaea_phase15_ledger.sql` | d3efef7211f77440416e1c84adc734a19c9b13f0d3d1f7b8176f1c5f42435bfe | clean |
| 177 | `20260418060000_tenant_assistant_speeches.sql` | bb8aea029597ff19888aff45252173cf50c74ba630c433b8896467927679112c | auth-schema 4; supabase-role 4 |
| 178 | `20260418060000_vtid_02000_demo_discounts.sql` | 62d9a5d4b6a681fbeb04c81966349cad067f67de8532223a4edf9d08075dd190 | clean |
| 179 | `20260418060000_vtid_02406_vaea_knowledge_hub_seed.sql` | 9415d6328664757d77b6478d001822fa638c0a927851bff4ce6628b2a4dabfd0 | clean |
| 180 | `20260419000000_vtid_02403_ai_assistants_phase1.sql` | 3ccb4ebc0b80cc4656693b9dce494a2bfa0fedfd1763bef3b96df0a07bc67944 | supabase-role 9; auth-schema 3 |
| 181 | `20260419000000_vtid_02407_vaea_kb_documents_admin.sql` | e078c0ceb6a34c9aaa398bfb650fda05a9c72bd443904119ecbdf9a761ccfaf1 | clean |
| 182 | `20260419010000_vtid_02408_autopilot_referrals_rebrand.sql` | 579f6578051e1db73eea610d09e160aea48ec0db6b4fd5b0ee49d40bfa90b301 | clean |
| 183 | `20260419094000_vtid_02409_register_ledger.sql` | 62a7d916a950e29be7580620c130659e04e0807538578d3a691c0c5b81e777da | clean |
| 184 | `20260419100000_user_feature_introductions.sql` | 514490ddae73ae909dc363b92ccaa48f324ce13f29df0eb452a740c8a0f9d97a | auth-schema 3 |
| 185 | `20260419110000_user_session_summaries.sql` | a9b951274a918071f3c6057f16d98a45cc82ff5679c58aad75cab09cbc7efced | auth-schema 3 |
| 186 | `20260419120000_user_routines.sql` | d190be17828a574fb6918eb04f8498c6f1f40917315ef59ed9a307a8f2c3d428 | auth-schema 3 |
| 187 | `20260419120000_vtid_01928_social_connections_google.sql` | bd7947b5b7043f75d928ea71bad10866e80d7cd6fa7d21bbab8f8f1f5ea9d1a7 | clean |
| 188 | `20260419130000_user_proactive_touches.sql` | b14f68ebe3df50aa8f4bee62cd25018f0a93bde61a47ef8639a6621188e5ee7d | auth-schema 3 |
| 189 | `20260419130000_vtid_01928_test_google_insert.sql` | 2dc724f5fb48daf7134efa4527078e7b721dd4cee566cc61fcb6cdec8f1f2716 | clean |
| 190 | `20260420110000_vtid_01942_capability_preferences.sql` | 8655d3ae02794062daca889e787b458929a98845b6350485c5ac535bbe9bf98a | auth-schema 4 |
| 191 | `20260420120000_BOOTSTRAP_history_aware_timeline.sql` | 9fcb4c9fab3dc2479dac730df914157601655218d01aaff828c2d032013274b2 | auth-schema 2; supabase-role 1 |
| 192 | `20260420130000_BOOTSTRAP_ai_usage_log.sql` | ceb56d58ac2ab1c94da690f042432f017f0ca9d7b1910a6915b89bc5a490ca6b | supabase-role 1; auth-schema 1 |
| 193 | `20260420140000_BOOTSTRAP_seed_ai_policies_all_tenants.sql` | 1c9979ce006659f9095484ca522f5d64d9df068a75b293531487d052f90d39a9 | clean |
| 194 | `20260420170000_BOOTSTRAP_seed_ai_policies_fixed.sql` | 3c77d188ee1bef4a251a6ff7c2c73d95f985197071040f0222af736cbc22ac46 | clean |
| 195 | `20260421000000_add_account_profile_fields.sql` | 3821875048d24519ed1f17b1fc6b377f7a156a6a9618a13d92785cddcaa2656b | clean |
| 196 | `20260421140000_BOOTSTRAP_awareness_registry.sql` | 343df89644573a8f7d317f6d652e4a319c716f965b6e951a0daf62e73213baef | auth-schema 4 |
| 197 | `20260421220000_BOOTSTRAP_admin_kpi_surface.sql` | 8b8c29a19575b9da474121020435f8c62e97a0f551b37bb71a2a87f80df72302 | auth-schema 2; supabase-role 4 |
| 198 | `20260421230000_BOOTSTRAP_admin_kpi_retention_fix.sql` | e04d2382423a9a9b0a9abbc7795383df970fac5bf1a0226b1cc5a42fcec31016 | clean |
| 199 | `20260421230500_BOOTSTRAP_dev_autopilot_worker_queue.sql` | 465821fd319ae25794f7d450197a86c3b3dc916c9ce630e44f6414db70fb874d | clean |
| 200 | `20260421250000_BOOTSTRAP_admin_insights.sql` | 69cc8b899de883b8ac9ae81f4bfba01521cdd2cfa13147c7ec5a0a79926c9486 | auth-schema 1; supabase-role 2 |
| 201 | `20260422120000_BOOTSTRAP_admin_insights_notified_at.sql` | 42411e7f3291cc583d5735f59e8f2c13ab91b9788d28506b61a26339ae5279f2 | clean |
| 202 | `20260422130000_BOOTSTRAP_tenant_health_index.sql` | 7f8ccadcb5fd0c147b375332266a0e11ef3c16d927953a49090c4f6e49aff04e | supabase-role 1 |
| 203 | `20260422150000_vitana_index_prosperity_and_weights.sql` | 2a2e8afb32a685ec0fe04285f180b603a525ac53d8ee27ac6000089ef8b64e5d | auth-schema 1 |
| 204 | `20260422160000_vitana_index_kb_docs.sql` | 04c7f48f7463901466e7b425f3044413a8f7fbf6b41f5334834b877f23f38d27 | clean |
| 205 | `20260423080000_vitana_index_scores_schema_repair.sql` | dafbda8a29caba51baf41c5c6842a6bb32d99ea35abe81c62f56e884c196fcc2 | clean |
| 206 | `20260423081500_vitana_index_scores_rls_simplify.sql` | b602a4b1474ea227a3eb1e7c05c27c629f6ff448f1a7afad6f621a60db29eb8b | auth-schema 2 |
| 207 | `20260423090000_vitana_index_book_ch0_to_6.sql` | f0da05b83c03e62e8ad9bd25f70cadcd59f71d9067c01477738b9250cdf8bad1 | clean |
| 208 | `20260423110000_vitana_index_5pillar_cleanup.sql` | ff614e543d03bcfa49a7e86fc2888f6b9345f80947168050f4dbf4fbe07dd01e | auth-schema 1 |
| 209 | `20260423130000_vitana_index_compute_v3.sql` | b1ceb3b5bebed1868f69ac5999f5506de433dbec8d39bd29dc0c889cb7cb5461 | auth-schema 1 |
| 210 | `20260423140000_vitana_index_compute_for_user.sql` | 9a4e9692dc2489d17f48930f0c6139b58e17ae65ae1f173fb39247c2389ffd2d | supabase-role 1 |
| 211 | `20260423150000_BOOTSTRAP_archive_false_positive_findings.sql` | 4e02f0e07b344961dc53a760523fca27cdc020afce42ec984ccc03d24c769182 | clean |
| 212 | `20260423150000_vitana_index_contribution_vector.sql` | ec7f5e53b3c282c0d16a71df2de3e6d9151ed3e6003e77b795fd199dad625335 | clean |
| 213 | `20260423150500_BOOTSTRAP_dev_autopilot_auto_approve.sql` | a6ed845c0e3a46d5e057fbb04924daef4bc15c24a284d92070b17f60c370afc7 | clean |
| 214 | `20260423151000_BOOTSTRAP_dev_autopilot_prompt_learnings.sql` | 50aca4a5a4a1f3132f52fd5674409f14383ae68d91e2889bedefb13b613df976 | clean |
| 215 | `20260423160000_vitana_index_rescore_existing.sql` | 33bb0f7a253bd9b5a05ecc7d8ade264403b2cd2b5e2bb1ba859f01e24bb0eb36 | clean |
| 216 | `20260423170000_vitana_index_rescore_retry.sql` | c6fcc72629d2ffb267ff15a674a7411f165ed772db0bac13605a22f3e8143cc4 | clean |
| 217 | `20260423180000_vitana_index_book_ch7_8_plus_rewrites.sql` | a8f170967584f42e365759f3963affab19b066a9618ded048c101dab35e0ac87 | clean |
| 218 | `20260423190000_vitana_pillar_agents_v1.sql` | 8cd302f3fb2a70475b8d696978c2ed302caa0551d44ae31367b7d5a7051e0cc8 | auth-schema 2 |
| 219 | `20260423200000_vitana_integrations_v1.sql` | 3c8bf37668d90421d255286e92c90e371cb99e85ba99bd7d1bead6d13560af10 | auth-schema 3 |
| 220 | `20260423210000_health_features_daily_schema_repair.sql` | 960ad2c1a216abdfbef3cd4a0864c9ead48e447f291825f2e31710af3ae84460 | clean |
| 221 | `20260424000000_BOOTSTRAP_dev_autopilot_scanners_registry.sql` | 86dde2d25e4b05babb62b2d2465983d361bcaea73e6086d94900793783da21d1 | clean |
| 222 | `20260424000001_public_vitana_index_rpc.sql` | 7066fac355cc5d7a75fd0c4f0f2375db7c06c2afa80a1e61e7213d870d7a9448 | supabase-role 1 |
| 223 | `20260424100000_BOOTSTRAP_dev_autopilot_impact_rules.sql` | 590afaff0ab1de20a8f600b2ecefc495b52cf347f53921592274d686c8877029 | clean |
| 224 | `20260424120000_pillar_tags_community_engagement.sql` | 55e9132a6bdaa79fbad63cf074297ff8d900f0dc6741912cd6d49309f9389f35 | auth-schema 1; supabase-role 1 |
| 225 | `20260424120100_vitana_index_book_ch09_community_is_mental.sql` | 8e66d81d1361fcd937b96a5a415e26d33cc30ea6dbba2644d2bfacf2f87c2557 | clean |
| 226 | `20260424130000_vitana_index_book_ch10_life_compass.sql` | a64fd48718b9c78045c8d3a88c316b52f41a5ddcca3937b0a7ce95a5a927f328 | clean |
| 227 | `20260424140000_user_pillar_recent_activity_view.sql` | 7f4b0fd7861e77f45a92ad1e97cca96dd0add4f2b4dfda27c6707fbb7667735d | supabase-role 1 |
| 228 | `20260424200000_BOOTSTRAP_autopilot_recommendations_impact_source.sql` | 4ce23f4fdcbedae6cfb86f7aa91a3bb3eeab04eb073e1d086106af11143e387d | clean |
| 229 | `20260424300000_BOOTSTRAP_dev_autopilot_auto_approve_impact.sql` | 46a6c7421e7f2a8401e61adc4b9695417fed6872aae74caa5b4eacae75149de9 | clean |
| 230 | `20260424400000_BOOTSTRAP_archive_route_auth_stale_findings.sql` | c33a7679d6d0fa3e47c33cefccd8f0c16b5f2835731fba9bce74f50d6fa0dbc9 | clean |
| 231 | `20260424400000_BOOTSTRAP_dyk_user_active_days.sql` | 7aa13626eadb3f82013cc0d9cac152bb4c5fe4501dfec995302aabe47c6832c5 | auth-schema 2 |
| 232 | `20260424500000_BOOTSTRAP_archive_findings_pending_rollup.sql` | afc348f3778e20ffb2e316311f1a1a3ea9768805fdfc5838d047099f233a4da0 | clean |
| 233 | `20260425100000_BOOTSTRAP_dyk_flag_on.sql` | 7982624d72bd04e068b65a4c44314f26971fe023ca082e5815a482403cb3fc1e | clean |
| 234 | `20260425100000_how_to_kb_corpus.sql` | 6ad61f55346c26f553ad44966ad274cbed83bec465607277f2b07eac414a832c | clean |
| 235 | `20260425160000_how_to_kb_corpus_v2.sql` | 84ea736a8c5a3cac19ebace08fbd95fa82d7129d724d509d1c5240e4d9e192a2 | clean |
| 236 | `20260425200000_BOOTSTRAP_dev_autopilot_executions_auto_archive.sql` | ccb0310e1a4bcf2bba7a0ead801bb8156d1e731e562b3dd24a60434832c15b62 | clean |
| 237 | `20260425600000_vtid_01959_voice_healing_dedupe.sql` | 45174988af0a9fdf1c884c5e01dfaec03af31e6f5c612be67a101a520fcff140 | clean |
| 238 | `20260425700000_vtid_01960_voice_healing_spec_memory.sql` | cd06a5d67612f0a25c3216d68a956ab87705f668ccd89af843fbd03d484e9f6a | clean |
| 239 | `20260425800000_vtid_01962_voice_healing_sentinel.sql` | b713f12a4b463ffafca7cf0e708612c983d13626cadffba2360263de716c1d5d | clean |
| 240 | `20260425900000_vtid_01963_voice_architecture_reports.sql` | b2eed763ed75138e74b482e5bb0d604ff967b5fdab722fc1a1a1a2a4c70005f0 | clean |
| 241 | `20260426000000_vtid_01952_memory_provenance_columns.sql` | a8dcdfef62e69904c35ae317d7f8d3c608f6c510c41cb1689547a459fe8f304d | clean |
| 242 | `20260426000000_vtid_01964_voice_healing_shadow_log.sql` | f890367c66654ee85d6f7462d95a92e4fbab5f1a198f2cc13f985603bfac1b56 | clean |
| 243 | `20260426000001_vtid_01952_memory_identity_lock_trigger.sql` | bca4210afa18ef50db555b89a0f29054f93fab99651b11ff8bf6324519991abf | clean |
| 244 | `20260426000002_vtid_01952_relax_provenance_check_constraint.sql` | ff8ed8e1b9601e0f877e3c3a619ea226549b2030128c8e1b6ffbaf8ef9008a56 | clean |
| 245 | `20260426120000_clear_dyk_test_user_touches.sql` | 921c5afb8da7ffca7a0afa20982b15e28edad2072a77d54c328f80e80683bdd6 | clean |
| 246 | `20260426154100_BOOTSTRAP_llm_routing_extended_stages.sql` | f1d15a58d49b77c537dd919a21e9676e9f0b6fedfb10559e33fac3554269029a | clean |
| 247 | `20260427000000_vtid_01966_memory_audit_log.sql` | 1f65d69177ab60f469395aad23806b23c2428da31cb4853c7fb20062304c1f3c | supabase-role 2 |
| 248 | `20260427000001_vtid_01978_fix_semantic_search_float8.sql` | 92627658b120af721549854aa11c5d90bba2d4f93b6a38137b4aba887846fbe2 | auth-schema 1 |
| 249 | `20260427000002_vtid_01984_exec_deploy_terminal_gate_auth.sql` | a797fa4d93141005b651c567bae9d9990c8bfb54725308886c4ff51c39baa8d3 | clean |
| 250 | `20260427090000_user_diary_streak_view.sql` | d845ff0de68990f89de890532e0e3adefb81a149d76c70fdb06135b3dba5e749 | supabase-role 1 |
| 251 | `20260427100000_BOOTSTRAP_autopilot_realign_substrate.sql` | 49a78c748696333c6c8f950a8d41020a696361516c8e0eecae0b95dda70e1e93 | supabase-role 4 |
| 252 | `20260427100000_vtid_01994_voice_quality_failure_trigger.sql` | ba6ae8e4b2f6e65d0a942a6be3a39214027db54a2860f44ea7a367479037a015 | clean |
| 253 | `20260427120000_vtid_01985_earthlinks_to_maxina_cleanup.sql` | 894c9eca7e51fc04b51fd360fc34f3c23cd3749d338198594214e73a61f138ca | auth-schema 2 |
| 254 | `20260427121500_BOOTSTRAP_autopilot_enable_stale_flag.sql` | 781381eaca45ca85a983b8768a8338e78802256c79c82ed1970cc7dd87cced98 | clean |
| 255 | `20260427130000_vtid_01981_routines_catalog.sql` | 1c953592a3e67570edcda6d705457d7dc0a106f22b8e5eec9f940aadc2a070da | clean |
| 256 | `20260427130000_vtid_01985_earthlinks_to_maxina_v2.sql` | ca4579f3770b9a284ed6aea0943ad593f66d066595e1fa5d5702a9d4edd9aa8a | auth-schema 2 |
| 257 | `20260427140000_vtid_01985_earthlinks_to_maxina_v3.sql` | 3eeabd44e3f96678d6535ff12706b0806f33b81082a918571c64199bc570cd13 | auth-schema 2 |
| 258 | `20260427150000_vtid_01985_earthlinks_to_maxina_v4.sql` | f863667d02fa85e1c1ef3e93c097640739746adbc4935a1bc35c6399f981947e | auth-schema 2 |
| 259 | `20260427170000_clear_initiative_touches_for_smoke.sql` | 3dd7f54e5dddcbe4dee9a78e9aa8c1dc6f7e3aa5a799b9dba4a67e316c54f3d4 | clean |
| 260 | `20260427180000_vtid_01990_vitana_id_mirror_reconcile.sql` | 91797078d652e9332a3f195fc4e24f0f0038c40a113148ce53e2aea26cb62c9b | supabase-role 1 |
| 261 | `20260427180000_vtid_02003_phase_5a_tier2_schema.sql` | ea4f3868c9c9dce89060a5cf415be43232877212b3ca356c9b58091938b2152e | clean |
| 262 | `20260427180000_vtid_02004_routines_tier_a.sql` | 7770e8d4f7e45e11d7d7a9cf6d3aa8a3c3ca829ef1921e920915ebf9ab1a546b | clean |
| 263 | `20260427190000_vtid_01991_intent_matches_archival_cron.sql` | 46e50e19259dfc9ff42fc7887922413a4e8a6f472f9fa4c14a9f0d2872bccd0e | clean |
| 264 | `20260427200000_vtid_01990_conversation_tracking_read_rpcs.sql` | 274d953781c98554cac5bbf016aa01a254887af0fc703d20b4bb45f6c5c9a1aa | supabase-role 2 |
| 265 | `20260427200000_vtid_01992_intent_embedding_index.sql` | e46ee96aec793938a00514bcf18f22fa05ab95eb92da5394811d5d42f8f1b725 | clean |
| 266 | `20260427210000_vtid_01992_register_ledger.sql` | 2a90bc17ab4d0f79a4440c5692ae087e69f7291b12545d5e493769bab38fcd75 | clean |
| 267 | `20260427210000_vtid_02006_routines_tier_b.sql` | 12d1d71f38aeecf99405fc550d3e063d77f352097a017275d289698a4d9e666e | clean |
| 268 | `20260427220000_vtid_01992_register_ledger_v2.sql` | fe61f9df5b06d268c0f85fc897356e23fe0e5efe4553a2c16882408aad103b1a | clean |
| 269 | `20260428000000_activate_recommendation_in_progress.sql` | 31119f52c299dc3921a55a5682432a70df37b73db318e02c8852841aadcfa01d | clean |
| 270 | `20260428000000_calendar_pillar_contribution_vector.sql` | 9d353fb821f3fc2182d09998c6b0ca61f2f269d62337af693e29438c52bd8a1f | clean |
| 271 | `20260428000000_proactive_initiative_flag.sql` | c1f6cc130f46bf8cee022f2adb01871042092ecc459623b8800c81d9ae7789b0 | clean |
| 272 | `20260428001000_analytics_celebrate_events.sql` | 25b03bc10ac1fc8452bdc1e91d92a831e1393eab940de648677c8ebfea25c4fb | supabase-role 1; auth-schema 2 |
| 273 | `20260428010000_initiative_flag_on.sql` | 1b3017a3033172b9a79c0c7bd73ba4a450335c6169555c1604d1344a6462ba9c | clean |
| 274 | `20260428100000_vtid_02007_phase_5c_legacy_backfill.sql` | a874a06faf42fb92c76ceec425a180d541a180590dd3da7671a449dea5b85f13 | clean |
| 275 | `20260428110000_vtid_02017_routines_tier_c_batch_1.sql` | 7b37942c769c726635af5dba8c4bb4420699438aaf2f730dce75d3e5a161857b | clean |
| 276 | `20260428120000_vtid_02018_routines_tier_c_batch_2.sql` | 91e2388afd91004fa7c2945e078e583527b299e56d8a4d8f91f3fccc76ecf493 | clean |
| 277 | `20260428160000_vtid_02050_mem_episodes_semantic_search.sql` | b9cc90fa40c216c27e0d9f2a4c23a9c6bf80f53df5271d308420d4ea366198f9 | auth-schema 1; supabase-role 1 |
| 278 | `20260428200000_vtid_02047_unified_feedback_pipeline_init.sql` | 9ed746bfc6e41c281cc54522b38d55f0a7f4db07de29271762aaaf3be30b36b5 | auth-schema 2; supabase-role 8 |
| 279 | `20260429100000_vtid_02601_create_reminders.sql` | 900bc6277959f2bc6925d0a480bc4efcea1357bfbef57856096b73b62073d724 | auth-schema 4; supabase-role 3 |
| 280 | `20260429100000_vtid_02603_feedback_handoff.sql` | ab53850c1652fbe74dc51cbdd38c8478364a30d94b50d1648481452c7885b90e | auth-schema 1; supabase-role 3 |
| 281 | `20260429110000_vtid_02604_feedback_classifier.sql` | e06e3ad5105a299405e6651eed3dd056153f0889a332548c15acbb82a0ddc014 | supabase-role 1 |
| 282 | `20260429120000_vtid_02047_phase5_management_schema.sql` | 47c06855b921b769088f66b43a627b187046111bc4fe3c2263ec45687c2be153 | supabase-role 12 |
| 283 | `20260429160000_vtid_02047_auto_triage.sql` | f5b1131bd3d689a9953c0e3c85fa9d3a791e555ceebfcf0b2eb132c41314e5df | supabase-role 1 |
| 284 | `20260429210000_vtid_02632_phase_8_consolidator.sql` | c356dc289078cccfc7f9421440e11ab857c30dfad994803b64631ddc88ead588 | auth-schema 6 |
| 285 | `20260430072429_instruction_manual_maxina_seed.sql` | 1dc5772c1bd43267b4db56bfcaf26f8f8ff4ac60e7ffc59acb4bd6eeae5cd502 | clean |
| 286 | `20260430120000_BOOTSTRAP_pause_dev_autopilot_auto_approve.sql` | e61f0aa2773789a7ee16dab38954d617a6e1e9655e7f70864ac1151cd7ade1e6 | clean |
| 287 | `20260501000000_VTID_02639_autopilot_finding_completed_state.sql` | 17b25839e1d4907a85febcbc2bb764fe8ba738813d4a04192474821571dc3b71 | clean |
| 288 | `20260501010000_VTID_02640_dev_autopilot_get_table_schema.sql` | 9ecef10913cf4cebdd508cfc0ffd80f9ee7b8a054f61801deba4989faa0ddc0a | supabase-role 1 |
| 289 | `20260501100000_vtid_02651_persona_voice_greeting.sql` | ef60f1e6025d95a622719384ffb5eac64401e92f2edfc7c92a881cfca8e24e55 | supabase-role 1 |
| 290 | `20260501150000_vtid_02652_phase6_tenant_overrides.sql` | 267ab1beb0383ec2f441b0337df8e076514a1a159912e7d8d4c1c80513142d0c | auth-schema 3; supabase-role 10 |
| 291 | `20260501230000_vtid_02665_feedback_execution_bridge.sql` | b7e3a89783e0a3e1e3a3baeb42ca56bb962c390c86c443434384ad9a086f864c | clean |
| 292 | `20260502090000_vtid_02669_feedback_autonomous_close.sql` | e60cf1575df88d214eca9e0008685c65c458ac7ac522333ac18f9a5cbbb84c7a | clean |
| 293 | `20260502100000_forwarding_v2_phrase_expansion.sql` | af1784521c8255c94dded9dcd92a7daccf39c608d44efea860c6c335707c1e4e | clean |
| 294 | `20260502110000_persona_identity_lock_prepend.sql` | 0fa5e6a118a35c3968bcd1b6603ce6b7e6ddb30a15181e66a6e546a7d0908c21 | clean |
| 295 | `20260502120000_forwarding_v2c_coverage.sql` | 5ad1d497571cd54f50d0dd75d1d06951e0c384aef134353c408f548d8aa07468 | clean |
| 296 | `20260502120000_vtid_02690_seed_orb_agent_google_cascade.sql` | 4b63caab85ec65c637314a5acfbdf0c24332211af3b326202935ddb34b54a271 | clean |
| 297 | `20260502230000_vtid_02686_autopilot_gemini_3_1_pro_preview.sql` | a472ff44ee8fccc2a20541bd9bb9484d101223c8773bf9ae1152c923d0016520 | clean |
| 298 | `20260507000100_account_visibility_helper_fns.sql` | d3951ac62ab34e39769ed444a125593df5d6662df328e303fcb5a72e93ec7b26 | clean |
| 299 | `20260507000200_profile_partner_service_offerings.sql` | 4aedb6a82408b7a5f987aa0f0abf3de3a2aeca6e2c6a23ac4f94fc083fccc248 | clean |
| 300 | `20260507000300_resolver_chat_peer_promotion.sql` | 97d8985bd4e8c2896dc5db210b76bfc00839802dcb924d93e510a83597141eb7 | auth-schema 1 |
| 301 | `20260507100000_vtid_livekit_foundation_voice_tables.sql` | 398413a9f764f0cbb75ef6278a548099564baaefe3ea7fea2d621b62c19c4678 | auth-schema 6; supabase-role 6 |
| 302 | `20260508000000_forwarding_rules_two_gate.sql` | 3b81d269a9f582b4f8e2d9cde30605500b0a09775d5f2f298fa318263db20966 | supabase-role 2 |
| 303 | `20260508001000_forwarding_rules_drop_old_rpc.sql` | 5cb17effa0c113c454b8eed6643f6ed64b29ab188ded791bad7523fb5ee9d851 | supabase-role 1 |
| 304 | `20260508002000_forwarding_rules_tenant_two_gate.sql` | 0873f9435ad7fe396282dc2811649383c0516786b92630e1181e16c130f4b02c | supabase-role 1 |
| 305 | `20260509000000_dev_autopilot_inflight_unique_index.sql` | 73aea6adfb30073b19edc0ee6c6231533877a0ada8914151da37ca95a10f671d | clean |
| 306 | `20260509000000_vtid_02702_feedback_rollback.sql` | 5f950f95183a957365d8f892427c267ebf2d24858721dfeec1ecc6e0289f9fbd | auth-schema 1 |
| 307 | `20260510000000_BOOTSTRAP_agents_registry_truth.sql` | bb4da69325e963fd2afdc92a65abfed68de445845e714e47f5149679940efb85 | clean |
| 308 | `20260510000000_vtid_02754_community_search_history.sql` | ad02b71a2f74a14bd1551738db4480f8a2954e08948a0e92ac88e53c35a77228 | auth-schema 2 |
| 309 | `20260510000100_BOOTSTRAP_architecture_investigator.sql` | e24ce0977bf7448ec9091aa1f05b0e4e4a00a90ee6dbf66c5ff8666b1d6b7f87 | supabase-role 1; auth-schema 1 |
| 310 | `20260510000200_BOOTSTRAP_agents_provider_check_extend.sql` | 48f651e085e0e710f1417b4dba308500fdbb3799b23a0bf8f7807af6fd82d190 | clean |
| 311 | `20260511111340_vtid_02866_voice_experience_scanner_seed.sql` | f0cfc0fd119cb7d8b69fdfb7a2f7f0ec411d3f7ba301c1e7c70383d388a5d1c9 | clean |
| 312 | `20260512000000_BOOTSTRAP_intent_cover_url.sql` | 89347b2b874f94cb25e137cb4e91000a3ba45c0f698de62b1fba8976fd628a2e | clean |
| 313 | `20260513000000_VTID_02806_intent_cover_library.sql` | 6be42d625372279b07d1cd066a0cd1905c0f0f3e000b0a903c9ce5533cf9a94a | auth-schema 5 |
| 314 | `20260514000000_VTID_02806d_intent_covers_storage_policies.sql` | a7b3fdb482b70a63a14efa1260cba34cd42323913d0d834c86e61a50398af584 | auth-schema 4; storage-schema 16 |
| 315 | `20260515000000_VTID_02806h_intent_covers_staging_path.sql` | 20906ec5f92e9080d2f1ffc44a01d682ce134db6ee7527e7d91cd10367924434 | auth-schema 4; storage-schema 14 |
| 316 | `20260516000000_VTID_02909_user_assistant_state.sql` | 247749fd4cf938d3aa83ebd6e70ac07aa6c1e92e2eaaee66250b9a0c2a099c7c | auth-schema 2; supabase-role 1 |
| 317 | `20260517000000_VTID_02917_orb_wake_timelines.sql` | d2da901801cf32b8b09a8b0c882e9af25aa274494857d8dcd058e1239d2d08d3 | supabase-role 1; auth-schema 2 |
| 318 | `20260518000000_VTID_02920_capability_awareness.sql` | b7fe6d4eb7eb7bd678c8d5d9ce522d813eecd21d33873cdfd60806404fa8d72e | auth-schema 2; supabase-role 2 |
| 319 | `20260518205049_instruction_manual_maxina_seed.sql` | 34a30052b0af7ccb7d226ab3eb7df5db061cb222c43ee5cb2ca2a1f22f71e9ac | auth-schema 1 |
| 320 | `20260519000000_BOOTSTRAP_autopilot_alignment_fields.sql` | a66561aa0d58932bafc968f7fc34452aaef365155737297ba1d569c79f9cfbd3 | supabase-role 3 |
| 321 | `20260519000000_VTID_02924_capability_awareness_events.sql` | e4ade49aeab8c0a4b37e21b456c66a8e58a2154ae070cad59d14c13574041332 | supabase-role 2; auth-schema 2 |
| 322 | `20260519010000_VTID_03091_capability_manual_path_and_extras.sql` | ed6cf4098e1acfc058d5f5accd312c7577efae40c38b00eac44098dae36865d6 | clean |
| 323 | `20260520000000_VTID_02932_continuity_tables.sql` | 1e00f26f4a5da3e1dbdad34141c1a8e02430b65e2f07bcbde6e424fec0a053a9 | auth-schema 4; supabase-role 2 |
| 324 | `20260521000000_VTID_02954_test_contracts.sql` | d2b5836353d7954213655e724eef2ddf08f7324ca0162fad686d3de05710f871 | clean |
| 325 | `20260521000001_VTID_02955_test_contracts_fix.sql` | 8530923974982a6259ce6e0c2094bf5c964d9ad3f1c551bf2588fe3738f6af84 | clean |
| 326 | `20260521000002_VTID_02958_test_contract_runs.sql` | 4f068ae133edd6219e341eca910420492f771484ccc3e56e684a4d620f843834 | clean |
| 327 | `20260521000003_VTID_02970_repair_patterns.sql` | 448a8c5566cee0d12a1356bce5528361b77be2f29b20858ac05c038167e504bf | clean |
| 328 | `20260521000004_VTID_02978_worker_runner_contracts.sql` | b5356f5ae469c0f37b20497ae7d79795364319b6ab010ffb4eed1384af2505f1 | clean |
| 329 | `20260522000000_chat_attachments_rls_dm_and_groups.sql` | 50eaa602539d9550d898a9fb2ae7145499087805a583011b4826a02cfdc599e5 | auth-schema 11; storage-schema 14 |
| 330 | `20260522000001_VTID_03025_livekit_hourly_tests.sql` | 9213ab190e3be2bf6ab7f09ab679445a6268b474cb0a144b673db19dfa3e9115 | clean |
| 331 | `20260522010000_chat_group_members_recursion_fix.sql` | 22b4e44fc8236a70de893426a9f50e69e84d1768d44f21447813c9afcea5d0a7 | auth-schema 11; supabase-role 1; storage-schema 9 |
| 332 | `20260523000000_VTID_03031_devon_male_voice.sql` | a0f74dd4d70afeef04d5a290d9ca7899aa0474b52f2ed815a78cc856b0778c0d | clean |
| 333 | `20260523010000_VTID_03032_devon_registry_and_voice.sql` | e99d596e71cebf39679ed7c3f71046850e1a21ac721715112e15d5c53adaaac2 | clean |
| 334 | `20260523020000_VTID_03025_livekit_test_seed_fixes.sql` | 8d6cb1e8bf0d1493eaadb936659668bf2c82232c321708b857b6cea71a463af8 | clean |
| 335 | `20260524000000_VTID_03036_bootstrap_cache.sql` | 8fc85a5e89af6bbbde2543dc73e87f24492c12ce89b9a122ca9499ff2f6c794f | clean |
| 336 | `20260524010000_VTID_03025_livekit_tests_full_coverage.sql` | c25e62db4b32608931877eb92237c1ae45365f3c83d6ffe5ed957b3ef5179d92 | clean |
| 337 | `20260524020000_VTID_03025_livekit_tests_smoke10_fixes.sql` | f0a39b691e79d4576b5871aadbb37192f1cb860d22b19730a53e1d358c86a02f | clean |
| 338 | `20260524030000_VTID_03025_livekit_tests_smoke11_fixes.sql` | f61e2c945e3380b56b069140d21fb9a92957611e15005b1951528af057dfb244 | clean |
| 339 | `20260524030000_VTID_03039_devon_question_cap.sql` | 307c5acc1114973f1c4e7f5097863784d56bf15845fcf6932575f33165aa5a26 | clean |
| 340 | `20260524040000_VTID_03025_livekit_tests_smoke12_fixes.sql` | 98275ce82f3010ef4d5db95a713a0891f5325102716f2398135827c9df66c852 | clean |
| 341 | `20260524050000_VTID_03025_livekit_tests_smoke13_final.sql` | d6eaed23f49b6f0118073b54eeeef4afbc2381353cb817a15b7df73c85b586a0 | clean |
| 342 | `20260524050000_VTID_03044_devon_only_specialist.sql` | 455bb3e46ff1a51637167883506d21f257190a9635a7bbd893786a8420bca065 | clean |
| 343 | `20260524060000_VTID_03047_restore_vitana_prompt.sql` | 5234485ef79a614ccc3346044f6ae12c91bb489542ddd2d0a05fe7bc3f140731 | clean |
| 344 | `20260524080000_VTID_03049_livekit_canary_enable.sql` | bf23932a58bc9d5791d7c93a7866ae82764affc91e6cc892e41c74933551a6a9 | auth-schema 1 |
| 345 | `20260525000000_VTID_03089_chat_groups.sql` | 69828d900fbe47b901aaf03a39c171587030f01bb3683cb3f908debd915c93e1 | auth-schema 5 |
| 346 | `20260526000000_VTID_03107_wallet_reconciliation.sql` | ec6976ed834450effbb191fd1e8f820cee6bb122b79e00ae7a068192563477d8 | clean |
| 347 | `20260526000000_VTID_03108_capability_pedagogical_order.sql` | d95bb6eecc541b0e2ad705db6a7aafe917922f9ffd0b40d0074168fe9f5c911d | clean |
| 348 | `20260526010000_VTID_03107_subscription_core.sql` | f3aa6f6de1b6701af1c57d1f6e83d345ffa7409ad1748bc1a9258100f5cb7251 | auth-schema 3; supabase-role 22 |
| 349 | `20260526010000_VTID_03152_goal_plan.sql` | 1ead8fc7f7b2630f1fe75210b8ad64aa669caa55efc21d20299ebf8a84f0ec1a | auth-schema 4; supabase-role 3 |
| 350 | `20260526020000_VTID_03107_openclaw_compat.sql` | 34430ea0e28c4cd8c32858c3aef8eadd3a2a7f9f7d2559af856898038bc01c0c | supabase-role 1 |
| 351 | `20260526030000_VTID_03107_seed_plans.sql` | 358f435a5a9f461fc89d1c95c405b2398080a6663c8b9135db2414208d97c226 | clean |
| 352 | `20260526040000_VTID_03107_usage_helpers.sql` | ceb7a48772ca9408b15780fa3974060b595081f40d278e608e8ada7a29e9b950 | supabase-role 3 |
| 353 | `20260526050000_VTID_03107_cron_cleanup.sql` | a3ee3eeaadadee8e3289f9b78e977a904b9b41d15601e2c4e261b59c19d6fa69 | supabase-role 2 |
| 354 | `20260526060000_VTID_03107_redemption_codes.sql` | 436eb1a1ff662662cb0c60ccd9c34243c0e0a4396d96afa409960957606afb6e | auth-schema 1; supabase-role 5 |
| 355 | `20260526070000_VTID_03107_features_json_seed.sql` | 367ed35974392843fa6460b2e30456703a14cf39e1123ab89390fcfb7ea44ede | clean |
| 356 | `20260526080000_VTID_03107_lifecycle_notifications.sql` | ada1894111d15a1dd98ef17b935d3473090484954395e2e19b1685b0eadfcb08 | supabase-role 4; auth-schema 1 |
| 357 | `20260526090000_VTID_03107_lifecycle_notified_at.sql` | 5376e319e7decea57c03dc535fc4dbc9329b6a253dc6cf4d075ed1693d18eb65 | clean |
| 358 | `20260526100000_VTID_03107_rolling_windows.sql` | 402e697baa1393edc624441f63b5648a319405bda1d3c1f9e4ea09b9c863800c | supabase-role 1 |
| 359 | `20260526110000_VTID_03107_launch_auto_grant.sql` | 70eef3519d6ae18ed230e2c1a6ff683996d2bb815956a08a3cede3562506238b | clean |
| 360 | `20260527000000_VTID_03113_decision_policy.sql` | d3848dcc0c29453e25be555da16275cf3d18996f1898c46a1639637d44ff2dc2 | supabase-role 1; auth-schema 1 |
| 361 | `20260527000000_VTID_03120_teacher_highlights_intros.sql` | 7828ceb773db909d641d49e6d621834204d7367d4b74ec2f8a815eaa9eb966f5 | clean |
| 362 | `20260527010000_VTID_03113_policy_render_block.sql` | ffc5dd827d0fe4d6677f8a59a01f1a579ebc415d6510370a8db212b27b33a9b1 | supabase-role 1; auth-schema 1 |
| 363 | `20260527020000_VTID_03114_policy_seeds.sql` | 19951d08cdad92937a98dc46ef4635a1c72035820b99a773acf9cfcfc3374c5a | clean |
| 364 | `20260527130000_VTID_03152_goal_plans_drop_user_fk.sql` | 4e166b8653c58742995e68cb4e542ffe942c40dc9e59e959ea124c6ac402d7af | clean |
| 365 | `20260528000000_VTID_03124_voice_thresholds_seeds.sql` | 81d03c1eb028c711b3f6f6deb40551e99eb32699600eca9cb429f070d9a45315 | clean |
| 366 | `20260528010000_VTID_03125_voice_connection_issue_seeds.sql` | 4c27fcbc510c430d2be070e08f37d0111fae3270634df043591b8865ca5b86fa | clean |
| 367 | `20260528020000_VTID_03126_live_api_voice_seeds.sql` | 2ba6b7c43dfb137df25c8e1dfe496ba7056ae03360d70e7d9f95faa9c83fe1e3 | clean |
| 368 | `20260528030000_VTID_03127_voice_cascade_default_seed.sql` | 1cbb1bbcba3ab8d57cb1d6225426fc9c65c9388e954085fb74fb1ef123755b69 | clean |
| 369 | `20260528040000_VTID_03130_autopilot_recommendations_provenance.sql` | 37725fa56c31e550a02111b273d1d162bf2629ff7ba7bc6cf909fbd85111eaec | clean |
| 370 | `20260528050000_VTID_03131_ranker_pillar_weighter_seeds.sql` | c78005a4382e487f3e988c3b94dd00e45892d1ea5ffcc9ebc7df3ba6884d92c1 | clean |
| 371 | `20260528060000_VTID_03134_voice_mapping_tables_seeds.sql` | cbbf33e7bfa16df7abfea0daa798d2425d6751149f912255ef3a55d781ff53da | clean |
| 372 | `20260528070000_VTID_03135_engine_thresholds_seeds.sql` | 4d01cc508990904e21ec1c413bcb134e98ad239a25f3a2ae92586ec30bf22c84 | clean |
| 373 | `20260528080000_VTID_03136_d33_readiness_thresholds_seeds.sql` | eae76e52b156e32003ade58c5526bf8603479bbc3b6e3cd5193b639668f6f0f4 | clean |
| 374 | `20260528090000_VTID_03137_feed_ranker_weights_seeds.sql` | 69912b6a133a7a2e824189684282863aae8daa1b13c8244c8fd56a49aaeaf15f | clean |
| 375 | `20260528100000_VTID_03138_marketplace_community_seeds.sql` | 93640854bee23bec3f45b2080b458b0c4ceeef1b13ce37e6c37c6e2f5586c984 | clean |
| 376 | `20260528110000_VTID_03140_signal_impact_maps_seeds.sql` | 077649cd842d2ad98207700dc25b62e1de0c17bc04d2acbb08a9fed81cafec2f | clean |
| 377 | `20260528120000_BOOTSTRAP_vitana_index_daily_stage.sql` | 9bbeb03c3ecb88bbd8714c91b06e561a9830d39e207a4c4371904bdc47b15dd9 | supabase-role 1 |
| 378 | `20260528120000_VTID_03142_decision_conflict_pair.sql` | 5098b5c96b9d9f6f90f44699088c0af0ddff1a00d13a9f53d2bc4c3adec818e0 | supabase-role 1; auth-schema 1 |
| 379 | `20260528130000_BOOTSTRAP_fix_longevity_stub_tenants_column.sql` | 206ce56e6f51a61346a90d6d168dae0b6c4a56b2ff2a61cd19bf3a9dc374ea35 | clean |
| 380 | `20260528184700_BOOTSTRAP_fix_longevity_stub_drift_proof.sql` | d6ff83f7b68929fff3ed0c7602b90c6975a5a6224b3375939524311b9241889f | supabase-role 1 |
| 381 | `20260528220000_VTID_03180_community_cache_materialized_views.sql` | 2b7454bd3502c992fcc37db7e572e9e0753bd60f8837d413042d3b33379e896b | clean |
| 382 | `20260529000000_VTID_03200_wallet_stripe_deposits.sql` | 317f0429f7cf910add6e6f58eaecc4402032b561adb16291a34ba6b084eee576 | auth-schema 8 |
| 383 | `20260529120000_VTID_03180_complete_autopilot_recommendation_rpc.sql` | 85985b15fd546fddaef6a4375276376d5c631e3319fa66f900c97a1a62c07237 | supabase-role 2 |
| 384 | `20260601000000_PHASE0_staging_software_versions.sql` | cbb78ae797625a30f74b33393ceb87ed291e6356da02945494a48e28762e4d11 | clean |
| 385 | `20260601000000_VTID_03089_welcome_chat_db_trigger.sql` | d424756f31e844bef0e96d857838950acfa947f25aa600eb8fc8a386b1c2daee | clean |
| 386 | `20260601000000_VTID_03249_wallet_spend_earning.sql` | 9dbc95d10ed23165d2efe829788885cdb9689d6660a818bf914d0b4f31cface7 | clean |
| 387 | `20260601100000_VTID_03147_longevity_economy_knowledge_base.sql` | 0994abf44b95315f31fb01a206b53751302b7a2d1c59a7b2f38f841c75caa435 | clean |
| 388 | `20260602000000_VTID_03150_longevity_whitepaper_verbatim.sql` | 0ffdfc67b4512afac6c33f37b2d18e8c2f76aed8fb57e533ee3f21becbaee8d9 | clean |
| 389 | `20260602000000_VTID_03255_journey_foundation.sql` | d628a2f419a8903e578ad1a97decb0ef5f1fd044677e0039da253cd59be952ad | auth-schema 6 |
| 390 | `20260603000000_VTID_03152_user_journey_table.sql` | 9b2b97813bb604f0910047ba8dcb84add9fd8405ed252583d97543f8406a30d7 | auth-schema 3; supabase-role 2 |
| 391 | `20260603000000_VTID_03152b_goal_plan_i18n.sql` | d6feea096f8ca31a4a231081781712eb09ea8deaf3ac054f8db0e9c73edc5625 | supabase-role 2; auth-schema 2 |
| 392 | `20260603100000_VTID_03159_user_journey_missing_columns.sql` | 9e9f3612532a69e36938117955c523bb7eae990523cfe2c680905faf3fbfb001 | clean |
| 393 | `20260604000000_VTID_03152c_goal_plan_goal_text_i18n.sql` | ccb7c7aad6cba1727559f21cd5ed4902aab92e7585c2ff1e4329a15f8ba330d5 | clean |
| 394 | `20260604000000_VTID_03161_decision_compatibility_score.sql` | 431c0c73b6da43df9b254ebea6a4b670d6a3870bd1bb3c855e0a4e12ec523342 | auth-schema 1; supabase-role 1 |
| 395 | `20260604123000_support_surface_human_only_queue.sql` | bfd55fece3c8ba26d23ba52a0105b840c49635f940dd3b53da3d7d150b21c1b1 | supabase-role 2 |
| 396 | `20260605000000_VTID_03169_seed_compatibility_matrices.sql` | 74c82e58c05efc26fc1da94f2db28e9385bfa8a7964f30003d85a0d85b217e5e | clean |
| 397 | `20260605000000_VTID_03186_universal_cart_schema.sql` | 295d8151cd24684cbb3cb3dc0ab9ff92bee6724ed33dcec8c93ffa46c4df9359 | auth-schema 11; supabase-role 15 |
| 398 | `20260606000000_DEV_COMHU_0503_orb_session_state.sql` | f0913bb8d61607833d3b416c5a8473071d491b926fe56771517637dee0ea5151 | auth-schema 1 |
| 399 | `20260606010000_BOOTSTRAP_training_cycle_tracker.sql` | 299aeefc6afcf1c72636746bcf3ade63aa45e4052769dcb7ea85e74312929aaa | clean |
| 400 | `20260606020000_BOOTSTRAP_training_cycle_day1_attempt2.sql` | 4fff6867d4867cb14c9cb78f87252fa913ab8cb57ac08b082c9aefb98cca9f61 | clean |
| 401 | `20260607000000_BOOTSTRAP_seed_community_onboarding_autopilot.sql` | c315ad03bb3bee8f8bc7f67f4575fb34c1b103e4e38ec16ff7ef4dea98c01185 | clean |
| 402 | `20260607000000_VTID_03237_video_shop_schema.sql` | e62fabdede9088ffef26460d2d6a312da7a660d426811a2f2ac0cb92bedb0e02 | auth-schema 3; supabase-role 12 |
| 403 | `20260607000100_VTID_03237_register_ledger.sql` | 345dc90fbd394c0519aa66392d7d6ed69318f58320022ec1d6ec3e3e051501dd | clean |
| 404 | `20260607010000_BOOTSTRAP_ORB_R4_teacher_capability_refresh_schedule.sql` | 16e72e6af1cd2272932e32d41dad51e7d968c826d7699b7dcc06ff32b73ad528 | supabase-role 2; auth-schema 1 |
| 405 | `20260608120000_phase_a_security_hotfix.sql` | 17070f7d41bb4277ac7469e77b6ef19234009e699779852d4ce723eb9bcbdb3f | supabase-role 3 |
| 406 | `20260608130000_phase_c_rpc_anon_lockdown.sql` | 959744ab3d68f3b8f8276d9c63960ae58ec7476bfe18df7d3448cce50ef6939e | clean |
| 407 | `20260608140000_phase_b_enable_rls_42_tables.sql` | 738a56a6d649fa3356873a5b55a05ebd774aea2717139012dce20e446c990395 | supabase-role 1 |
| 408 | `20260608160000_VTID_03276_guided_journey_mode_state.sql` | bedaad0c145e5f231175c987d4f19153c314be57d78aed3b609f7a0c5509155f | auth-schema 3 |
| 409 | `20260608170000_VTID_03277_journey_checklist_schema.sql` | 586978c0a9e7abee34cb305126334bccc6593fbedda4353cdb9f6bb807ed98c9 | clean |
| 410 | `20260608170100_VTID_03277_journey_checklist_seed.sql` | ae43abb0feec4b0a730c0b8d01fa3315aa239b10ddddab441c42af9d13d5bef0 | clean |
| 411 | `20260609120000_VTID_03288_journey_checklist_grounding.sql` | e56af9c6490efe43e913cfa074e43afbc3a93308c23066649e85fe08d8e1a8b7 | clean |
| 412 | `20260610093000_nav_catalog_mobile.sql` | 3b537c384ee54156d9e885d5cd518abf017172cf2285376de5a71ab1ddcb5680 | clean |
| 413 | `20260610120000_BOOTSTRAP_journey_session_index_award.sql` | eee9d2b31c8a843471732ef938435872d0e01c3df922b5d90cb7e27e6739c496 | clean |
| 414 | `20260610130000_BOOTSTRAP_journey_checklist_translations.sql` | 3f3c8c6058cb814efa9829769bcec0973f2330e385a42521c44ff6b32953969f | clean |
| 415 | `20260612000000_BOOTSTRAP_content_i18n_catalog_cache.sql` | 2f0728107595d7a85ded239fe080f1b59ecce6d8f7cf2ebbb0423977cfb0044f | supabase-role 1 |
| 416 | `20260612000000_bootstrap_orb_latency_phase1_retune.sql` | 3c91e2fe3de1e6b5f773daa1fed283d2841c0a8581115f1d1443b189ce9e5c9f | clean |
| 417 | `20260612140000_BOOTSTRAP_product_analytics_events.sql` | 295fcf1a008d7beb4b3c929f7753c9d569f64a617155119e5fa2220089c1918b | auth-schema 2 |
| 418 | `20260612140100_BOOTSTRAP_product_analytics_rollups.sql` | 263696e120d463fa0c6394a1370974850f8348e7d2505d80263171d54d33721a | auth-schema 2 |
| 419 | `20260613003000_BOOTSTRAP_first_time_onboarding_sessions.sql` | 26ff33369d92336bceebd93bee092df5a4519101e91c8f4c18f20c4e05d46f09 | clean |
| 420 | `20260613080000_BOOTSTRAP_journey_checklist_de_labels.sql` | 23aad56147b68f6856ae67e3b8dfe60dfa22f90e3cfd482a41a3d686c94d9cb6 | clean |
| 421 | `20260615120000_nav_catalog_platform.sql` | bb9f1facf4dc0d0bb566995aaf21f0a9922d617b921490f2b7c231f558fef98e | clean |
| 422 | `20260616120000_nav_catalog_desktop.sql` | c226ecd278caa249900368cab3b9e5a77f9aa4f592c18f6c92a5f58c426a347b | clean |
| 423 | `20260616130000_nav_catalog_mobile_drift_fixes.sql` | bc869b1289051a467fa590ea3a4929716b97609be687ebe60f32bc11cc7e7a39 | clean |
| 424 | `20260616140000_nav_catalog_desktop_tabs.sql` | 5e8c4bd849c031b9ef477c403975318280ce9a1be3ad03eb34d7aacb429a17e4 | clean |
| 425 | `20260616150000_nav_catalog_desktop_tabs2.sql` | c37d7254c6d7bc3f58baff54ace3f44b30020129c70c79e43287bdb0e7baf4de | clean |
| 426 | `20260618000000_BOOTSTRAP_canonical_people_search.sql` | bed0ca96c2d752bb450cd6f7351b81e532faf8c0c01b4fd766b7f222bf8efc67 | auth-schema 1 |
| 427 | `20260618120000_BOOTSTRAP_resolver_match_quality_dominant.sql` | 618ff01f6805317793384beff43589b4aa3da95f576d3be89c97f9deb71d200b | auth-schema 1 |
| 428 | `20260621150000_BOOTSTRAP_publish_journey_checklist_v2.sql` | 5c0c30c20bc76a87e123e70cea59e711b5bc0aff6000d14e68d4e12f9ee05aa5 | clean |
| 429 | `20260625000000_alle_beisammen_chat_group.sql` | 94df287f02857428791c5fdb9f57ac4ea8b40136a8e8926e5591e1206cd75524 | clean |
| 430 | `20260625120000_nav_catalog_role.sql` | 8477d06a8cc5a3888d95215196971990c03260d13509cacb597de1562d4edb16 | clean |
| 431 | `20260625130000_fix_feedback_classifier_two_gate_fields.sql` | 04c2b58e3699a0f41919f3463815634c0ba297c8c65a5a9662f6e89ce3ae628f | supabase-role 1 |
| 432 | `20260626220000_add_last_full_briefing_date.sql` | 783fb92851319af1780f2544a7e0bd6768d8e8da9d263df8c393a5a0150322d8 | clean |
| 433 | `20260627100000_add_recent_nbas.sql` | ae2e6094fd01664c6d58628b4f6d434348d0073d2824dd43fee875ceb4aed744 | clean |
| 434 | `20260628120000_conversation_flow_test_impact_rule.sql` | e69d7368b2c65ffc4f59956194de4b0f4822c65975665e7af90a2d8f3cfdcad5 | clean |
| 435 | `20260628120000_fix_allocate_global_vtid_seq_drift.sql` | e137895841d951c4054159bd6d723c219494e10376035e44472f95f5e3a824fe | supabase-role 1 |
| 436 | `20260629120000_vtid_02000_discover_admitad_real_catalog.sql` | ee2a235d43ca3cf938497ac90c7967b1a4404117cc3ce93f461e47e3a1737d15 | clean |
| 437 | `20260629140000_vtid_02000_bodylab24_product_deeplinks.sql` | de56db61dfddb6eab0eadaa74c2e458607a284d413d25d6e68b8bdb3584592fd | clean |
| 438 | `20260630100000_transport_flow_parity_impact_rule.sql` | c8b44d34d58f5f9c928426a9486c74926b4c961aebdcc8853990ebdb80c42ec9 | clean |
| 439 | `20260630120000_BOOTSTRAP_reap_stale_live_streams.sql` | 41cff6f87d5cd8e27a471722bace084a065f624efe6e1f87658a3b0847a8b286 | supabase-role 1 |
| 440 | `20260702120000_vtid_02000_amazon_ae_recommendations_seed.sql` | f3a3910e8055870b5eabcb5aa4c21ad350d3dc933c47ad16440a5cc6674a4a91 | clean |
| 441 | `20260702160000_vtid_02000_admitad_feed_source_network.sql` | ec276d0cacfddf7b42362fb3d0d7a5dc90b7451970520ca8c9b428c1ecc1815a | clean |
| 442 | `20260704060000_vtid_01250_automations_engine_safe_part.sql` | 538b5f57e2834e961d9f5c51f43e2bc92ac0594133523e2594395d3b14c30d6c | auth-schema 3 |
| 443 | `20260704120000_nav_catalog_my_journey_sessions_disambiguation.sql` | 60e96f95a98acb8157ff288d86b6db7ec6a9e9bd227bd64faaba9e8690ac849d | clean |
| 444 | `20260704200000_vtid_01142_contextual_opportunities_table.sql` | d270ab6feb543f4c1d9f2f282f032c041aa8c869a05fe9e3aa87290ced250819 | auth-schema 2 |
| 445 | `20260705100000_vtid_01250_relationship_edges_allow_connected.sql` | 6a5763821f87f8e20d69382346ba785772f8c1d2bad05106e8c853e09c8df18a | clean |
| 446 | `20260705181500_transport_flow_parity_flip_blocker.sql` | 2e6542ce78ecf404bc4d796a7ca8c772f828252d444be59a8bb9cbe6e939ca33 | clean |
| 447 | `20260706100000_vtid_02779_voice_clock.sql` | 6d8e8e4dd47862106478c4a4cd3ea19043192f078078cc9f3cd1502f5f1012e0 | supabase-role 3; auth-schema 2 |
| 448 | `20260709120000_vtid_02000_bodylab24_real_deeplinks_admitad_cleanup.sql` | 7528c6cfbc902ed872e22633666329f05deed5c6aa6ecadc785553ab045873a4 | clean |
| 449 | `20260709140000_vtid_02000_amazon_ae_real_photos.sql` | 39bda70ddda376b785d99b129dfd6228ee275d0bfc6c9df42ccd860da22ec4db | clean |
| 450 | `20260709150000_vtid_02000_bodylab24_real_photos.sql` | 9aee6244e524429a80b86829e938d9948397dee8a437a94b84d945048e210e34 | clean |
| 451 | `20260710120000_fix_reaction_notification_deeplink.sql` | 7c01bf3d28b48a3cbbc2fce6b0eed9f9e304c7a77ee9fe1d79005ba9824d9293 | clean |
| 452 | `20260712100000_SECURITY_fix_public_writable_wallet_and_cache_rls.sql` | 9d68561b5db9666b65e2cd2998d59c37ef44a1499a9b565550573ced15ef25cd | supabase-role 10 |
| 453 | `20260712110000_SECURITY_revoke_anon_grants_vtid_ledger_marketplace.sql` | 5455b7e2d45c3894999bb0dcac5096ce0dee96ad9096325397c11c67e4045fed | clean |
| 454 | `20260715120000_vtid_02950_recommendation_commissions.sql` | ac3a7fb997e37222d95cffc2055c036c4bb800ec9c873ee03716746ffabf7c8e | auth-schema 7 |
| 455 | `20260717120000_harden_wallet_rpc_ownership_and_rate_lookup.sql` | 005cd2d2fd6ca3204834e05d345e0261782769928beaddd84ea5b07098aa3498 | auth-schema 8 |
| 456 | `20260717120000_vtid_02000_discover_doctorbox_seed.sql` | 8be56dd87b9422f57e47cfff7a3d61d54b0e3a2726f996364c86b9a6457b2ac3 | clean |
| 457 | `20260717120100_reset_all_user_wallet_balances_to_zero.sql` | 766ade6258e22e7ada5adcd570f8c8e3aaea0d6f03af6ad72b88b1e1ee7d8a62 | auth-schema 3 |
| 458 | `20260717121500_vtid_02000_doctorbox_feed_category_mix.sql` | c4b0dbb1411b94594a5ce5dfa2f78223679affc5de5169987a4a39708e30c412 | clean |
| 459 | `20260720081500_vtid_02000_doctorbox_feed_featured.sql` | 9f80c41f8aaaf44053b4f5665cc623d26905044d1c588dff3022e064559fa950 | clean |
| 460 | `20260720090000_bridge_credit_deposit_into_legacy_user_wallets.sql` | 618b7e05650e58f1c2b6fb4937b55673b41f6c7cfce20136697c9b25479d634d | clean |
| 461 | `20260720190000_fix_wallet_rpc_atomicity_and_transaction_logging.sql` | 86e067ddf9eda22306a8785393f8418b4ebf976b7d6dea0ebec8852cec7f4bb5 | auth-schema 8 |
| 462 | `20260720200000_fold_vtna_balance_into_credits.sql` | e14d6e6757d2af7c0b07be331e4254852d80bbc95924f36c029fc1972fef9ed6 | clean |
| 463 | `20260721000000_vtid_02000_doctorbox_real_photos.sql` | 9e45e5e912666f2389a4f49d36bdb16e9de9a722ae3663f9fd1b6d1cff1f5d5f | clean |
| 464 | `20260721180000_add_wallet_transactions_profile_fkeys.sql` | 0f76bcb0bd2642a9d370e0b47353775b122649702a2598d1c2e29c11382591f3 | clean |
| 465 | `20260723000000_vtid_02000_doctorbox_per_product_deeplinks.sql` | 4a3df48561d138fea0ed690ccce2cebc72e0924d610e23b2b550383b10c5fd18 | clean |
| 466 | `20260723010000_vtid_02000_doctorbox_new_products.sql` | 721998aca4ee1dc2ccfd600b51700094b747271f374c6bb8e005307c4f7415eb | clean |
| 467 | `20260723150000_bootstrap_feature_announcements.sql` | cd8e6c566558cbd542d06bc2e191011427b0472d1849ee9fc34265b698c8b3ee | auth-schema 2; supabase-role 2 |
| 468 | `20260724170000_bootstrap_daily_feature_tip_state.sql` | 4fe764f556dc4943c77e1a7f324848c583d404cb9d3b8538d581d5a242e4b3dc | supabase-role 1 |
| 469 | `20260726120000_vtid_03413_bedrock_worker_routing.sql` | 299adf75483bc80b25a10f2cfc3230976aba0821bec1e251cd68e89d031ddaef | clean |
| 470 | `20260727090000_bootstrap_community_marketplace.sql` | 9b5a5d6c116f26872a6a49b8d6e1668677f5ea7d4b215efc2693167f207df168 | supabase-role 13; auth-schema 8 |
| 471 | `20260727170000_bootstrap_community_marketplace_storage.sql` | 4e0526b16f48034f2061af14433d172a80c081bcec09f8f9ddf0a1a4b7816210 | auth-schema 4; storage-schema 13 |
| 472 | `20260729120000_nav_catalog_settings_tenant_drift_fix.sql` | 265960ef5c6c96608c818f9eaefe3926bc149d9b27a8bf28ef34a4e3e9b59b9b | clean |
| 473 | `20260729150000_bootstrap_community_marketplace_seller_suspensions.sql` | 31bebf527cda8adc0e35f2eee315370d57c7d39783482cc7a4c1f449eb6fa8dc | clean |
| 474 | `20260731160000_VTID_03460_watcher_steps.sql` | 5e20b5b51e4e56d6415dc6dc2225b0c08d946130364c13b78d88773e53c66afa | clean |
| 475 | `20260731180000_VTID_03461_watcher_lessons_rules.sql` | 118b9afa94e4dab7f8868c0284ea2c809d39db5e6db1ecfaf3624d1f295900ec | clean |
| 476 | `20260731200000_VTID_03462_watcher_feedback.sql` | 5ea770766798b60a8b4690a9428e575f915bb44d728383f0db8891f947ff2197 | clean |
| 477 | `20260803200000_vtid_03481_device_token_ownership.sql` | 0805af8a8e3f55606672035a1bcf76ac8f6b116dc3c8dfa5327ada0b5758f2a7 | clean |
| 478 | `20260804080000_vtid_03486_ci_health_rpcs.sql` | 7d3a6a7a21c380c5d6e7542d32dded7a2dd8c91817660c311ebd56c4fae41491 | supabase-role 2 |
| 479 | `20260804100000_vtid_03492_ci_health_rpcs_v2.sql` | 899c8c40eaabb5bf020ee6f8b25bf46400f9727eec7f384151dec851bac35fe9 | supabase-role 2 |
| 480 | `20260805120000_vtid_03493_recent_conversations_order.sql` | d1eadfc42f5d2331537180a8702ee815af146fe5d2b9d10e209bd6c87878cb94 | clean |
| 481 | `20260806090000_VTID_03515_db_i18n_locale_registry.sql` | 580e388418519b186cf52263c1841b2b79fecdf0c9eeb119deced8d589fc54c0 | clean |
| 482 | `20260806160000_vtid_03516_ledger_integrity_check.sql` | 065575f452375057086995b8548394883da79df495b2428132b68575b07b1057 | supabase-role 1 |
| 483 | `20260810120000_vtid_03565_seed_bedrock_allowlist.sql` | 4e0b1528f8ee7875880cde3f7d57e9ce9a4a660ceb94f6cf28cbc0b674ccde9b | clean |
| 484 | `20260810160000_VTID_03575_zh_register_hint.sql` | 7d4f297b9252ff1f9b9c7836aabc717efb39d42c002e4d4ec70895de3500e1d4 | clean |
| 485 | `20260810230000_VTID_03580_promote_pt_ru_pl_ga.sql` | 4e62c55bc9c0c5600c79850927f2267042bad614a2c65326a79c9e334f72e35d | clean |
| 486 | `20260811210000_vtid_03599_llm_telemetry_summary.sql` | 028cae0bd50aae41fe238404d96917d84a3460cf7c574c5258a6eed9a9f85287 | supabase-role 1 |
| 487 | `20260811230000_vtid_03604_day_close.sql` | 5be8b9072a0d782470ca9bf4ba2fd806d70e2f67da1c85167d2aa1aee9613dde | clean |
| 488 | `20260812140200_VTID_03623_resolver_drift_fix_chat_peer_flag.sql` | d17edd4d704f7db8ec9e0fb336788be72b67d44fcb8e44ba66739a42853cee87 | auth-schema 1 |
| 489 | `20260818090000_vtid_03666_ci_vital_systems_health.sql` | d978f7b5fd1f158b5d36d03b289b4f01255801c99e18ba418d42983b48cab3b0 | supabase-role 1 |
| 490 | `20260819085846_vtid_03679_fix_de_locale_journey_checklist_false_positive.sql` | 716ac559a4d5ec3b0a3b07d39d60e509ed16f3753c27ad0acdd7cfb31f571aff | supabase-role 1 |
| 491 | `20260827090000_vtid_03767_fix_seed_community_onboarding_autopilot.sql` | 2949acbcde8a4300547a51b0a0ca0f206cc022ae3480a9542f9ce3d695d0c171 | clean |
| 492 | `20260911120000_BOOTSTRAP_deepseek_v4_1_flash.sql` | e7a925318470b86b80ea342774a74c6979049ca7dab9aa65e057ccc44cc15999 | clean |
| 493 | `20260912120000_vtid_03819_ledger_dedup_embedding.sql` | 4a9fdbe92159b033ce39ecd0e10b65fba425366873f650a3e0a1a609c33e206c | supabase-role 1 |
| 494 | `20260913000000_vtid_03832_vitana_role_add_values.sql` | 87e57eba53dca7fabbf449a968893f9715f2a67e5c7aa13846a0ed36f494eacb | clean |
| 495 | `20260913000001_vtid_03832_tenant_role_add_values.sql` | 987791373af1f13dad8c55b5f591c9fb00ac41a34ed01355a5da9abd0980159e | clean |
| 496 | `20260913000002_vtid_03832_role_functions.sql` | fe73f5063a5100cb82a35e41a033950348471d1f32142a253e551171a96007e3 | auth-schema 12 |
| 497 | `20260913010000_vtid_03834_erp_capability_grants.sql` | 817b236c5ecc12c459967d8e707b366b2c98d5ee964994aaf50bfc0557a4295b | supabase-role 4; auth-schema 1 |
| 498 | `20260913020000_vtid_03842_erp_commands_approvals_audit.sql` | 2b2aca0b0943912f4affc539507a1f8088c434ad7a41debe9eedaafa4d98f665 | supabase-role 9; auth-schema 1 |
| 499 | `20260913100000_vtid_03844_outcomes_source_type_allowlist.sql` | a375cbc2d62e1eb774ba9b333ada9d8766e0823ea445ddb3cb6255ed5d1a4b06 | clean |
| 500 | `20260914090000_vtid_03885_partner_health_test_integration.sql` | 714a7dd76165718fd60cdd4f0540df3921fc28954a0e2ef121f61695cf1b7f61 | supabase-role 1 |
| 501 | `20260914130000_vtid_03842_erp_tables_revoke_browser_roles.sql` | 5af9be33cb0d19f16b9fcf1e45dc00123f97792d6fb4d38a34b32b7fe4690f42 | supabase-role 2 |
| 502 | `20260914182357_vtid_03889_dev_agent_memory.sql` | ae661179d894150edc97f174cae866009d2bce4c90ac1a77683051a04d552ba7 | supabase-role 2 |
| 503 | `20260915100000_vtid_03894_supplier_verticals.sql` | 6b4c461f5e183e88caa4e9b517f9b4a5e79f5677c68d78a10b9330b618e43dc6 | clean |
| 504 | `20260915100100_vtid_03894_seed_verticals.sql` | 6e92fb87ded6c58e41ce0c4cc9f780ca985da8e4a998b892c2b6f892060b58a3 | clean |
| 505 | `20260915103000_vtid_03894_supplier_affiliate_link.sql` | e92f68e958e249233c4ed1853fa7e061b3810d25949ecf398585591875bbf33a | clean |
| 506 | `20260915120000_vtid_03932_partner_organizations.sql` | 8eeaffb6de0dc25e8eac2508a75360fef6149d0daa5758c7f4a56164661596c4 | clean |
| 507 | `20260915130000_vtid_03914_role_preferences_check_backoffice.sql` | 46096c21d8c94779898b5a7959b12a08418c0478e0921a7f8500078964240eb2 | clean |
| 508 | `20260915131400_vtid_03916_widen_role_preferences_check.sql` | 8b64cee5f5990901e7ef6309aa81d7e1c6933ab9da75972f76a9509e5fc0de68 | clean |
| 509 | `20260915132000_vtid_03894_catalog_vertical_rls.sql` | abf2a72e372ef9ca4917b141c7bb5c118a37494b1f2308c746e7b7600c7cf376 | supabase-role 4 |
| 510 | `20260916130000_vtid_03974_commerce_vertical.sql` | ce04e0df6cbb6963b9e238f6523166e01ac221ca8eed4946b29f0a9617d5b14c | clean |
| 511 | `20260916150000_vtid_03972_widen_oasis_events_retention.sql` | 805b06ff1f5251a7cb086e075b6902ae3f7a792a3243681a19b08f3b5e664b16 | supabase-role 1 |
| 512 | `20260917084341_vtid_03990_service_bot_accounts_skip_welcome_chat.sql` | 519e1a490088f560b113e6a105075b599198a43e3416bc1434cd0c18b3cba309 | clean |
| 513 | `20260917100000_vtid_03995_role_switch_community_and_membership_roles.sql` | d64068b6dee85acabe0aba525bd7e6ed2ebf3f4b1f7c2d40c6e22423c7d4a863 | auth-schema 7 |
| 514 | `20260917210000_vtid_04005_dev_autopilot_allow_scope_widen.sql` | 838aeb81c7739df2420dcbd5d6aaafca51b6d07e9b1e69d4aa164ed081c9bddd | clean |
| 515 | `20260917230000_vtid_04022_operator_threads.sql` | cc2fd8b654e2fbd974afda221e79e9adfc8197b88e79c39d566c533ce3c8df12 | supabase-role 4 |
| 516 | `20260918000000_vtid_04029_dev_autopilot_executions_awaiting_approval.sql` | e7bca93eba02f25a8f08a983dee718b8235eb005c0f91105003853603d60f6a0 | clean |
| 517 | `20260918100000_vtid_04044_lab_reports_rls_user_scoped.sql` | 620a7471445622427f9f1fba26e3a6499fbe1fd5a3792e2b762a951658e1594f | auth-schema 2 |
| 518 | `20260921120000_bootstrap_dev_agent_memory_file_scope.sql` | d25bc6a12ceafda436028401e18901abcfd39aa51845f29faec37d87149beb74 | supabase-role 2 |
| 519 | `20260923120000_vtid_04319_orchestrator_run_ledger.sql` | ea7fa17ccc075dbffc3e0eda9f4edb519306584011410f171a16f69d525093be | clean |
| 520 | `20260923120000_vtid_04321_rsvp_calendar_global_events.sql` | dfe7292bc7dc7f68f201865149a9ebb0b70ee2569ebaa3be4f3e4c8e6d7a40c6 | clean |
| 521 | `20260923120000_vtid_04337_partner_org_members_rls_no_recursion.sql` | a33407f2992ba58fe5f102801aedc0205bb458dc41c9caefd3e5ee60cc63c725 | supabase-role 1 |
| 522 | `20260923120000_vtid_04341_write_fact_skip_same_value.sql` | 5acd63b0624c55a68568cd5f4a81ac39fe1110e04c4b8336457551eefe028c06 | clean |
| 523 | `20260923130000_vtid_04331_calendar_data_model.sql` | 57caf939862041b2af72585552722079cc9ec9ab3b14b4f47af2c8f82e81ed3b | clean |
| 524 | `20260923130000_vtid_04333_auto_triage_all_bug_priorities.sql` | 878a712c62707f5d2cc742e92eaf6dde475742a47b57ae40af3de8a8ed11b493 | supabase-role 1 |
| 525 | `20260923130000_vtid_04342_memory_embeddings_titan_v2.sql` | 7bdc972b6135edd50cf6c2eca377687f560f6831b00ea229d41282712e5f0648 | clean |
| 526 | `20260923140000_vtid_04338_calendar_default_reminders.sql` | 05d3693d25a917101f780b28c066acfd813d5e400dca110e2ed2515e74493e9d | clean |
| 527 | `20260923140000_vtid_04345_ci_memory_health.sql` | 3262f1a9bf9f6092d4282f7c352076b3f991bf8df2258514ad2efdaf73de321d | supabase-role 1 |
| 528 | `20260923140000_vtid_04371_conversation_metrics_hourly.sql` | 40f19d06593e8d4b75b81c99fe833d360043ada98453f4fd151f25870f2e6a32 | supabase-role 3 |
| 529 | `20260923150000_vtid_04365_session_summary_episodes.sql` | 855b490e51afffa03850d22a02d49720027b2962706a91691802bd22d9666e04 | clean |
| 530 | `20260923160000_vtid_04356_calendar_source_producers.sql` | 672e740897f4b905c8a02ec3c48776b15133d86722f4e3c715336d63216d1dd5 | clean |
| 531 | `20260923160000_vtid_04387_memory_transcript_turns.sql` | 4fa88c3c7f69a9d18c72f4feac974e1d7c42d668c765cc531f507c461fcaea70 | supabase-role 4; auth-schema 1 |
| 532 | `20260923160000_vtid_04399_metrics_context_setup.sql` | d68ad06866e77a16bf9660168e5a5bac0397ed474d503bfbecac2dd1699b60fe | supabase-role 1 |
| 533 | `20260923170000_vtid_04358_calendar_feed_tokens.sql` | 1dde51201f2461041f3be7cd368faf78764be98faec91525a14c4767065f77cc | auth-schema 1 |
| 534 | `20260923170000_vtid_04389_garden_legacy_backfill.sql` | c18a855ed3015a934767d18ffd39c1bd5dc85fe3647c3b1bdf02d8055cedb366 | clean |
| 535 | `20260923180000_vtid_04372_calendar_google_sync.sql` | db7d1d7e849d5e6b2c6e20a046f9267edb2f6433ed2feb12a7ea395b52ab6abf | auth-schema 3 |
| 536 | `20260923180000_vtid_04391_daily_learning_episodes.sql` | 1e8cd216014c64c5b65a85f47b735c543a2d847a72362fba95c9ebdd5dcaabdc | clean |
| 537 | `20260923190000_vtid_04407_dev_agent_memory_handoff.sql` | c960f5c1a876c3f4fbe60d2c60de58f3b14b3dc5c3aab14ecfbd6a2514e1ae34 | supabase-role 1 |
| 538 | `20260923190000_vtid_04421_conversation_offer_outcomes.sql` | b0fe00e5250af05ea3f8fde5f937fbf22a9aa052ad9ce4eaa071e7a50393542b | supabase-role 1 |
| 539 | `20260923200000_vtid_04402_connected_apps.sql` | 56bc3f42ae15c58bbc14395a7777c682dd1ccaa7674a5a10bde14b8302e0de05 | auth-schema 2 |
| 540 | `20260923200000_vtid_04411_customer_support_memory.sql` | e32c4d8c7731d8fc9b943bf31d07a85aaae9b8dec0580995f8383c345dcdd7bc | clean |
| 541 | `20260923200000_vtid_04422_conversation_scoring_weights.sql` | 065f2b04f2d12baf957c3d1af2841d7abc25f939d1c787ef32e0e291688a12ce | clean |
| 542 | `20260923210000_vtid_04431_support_resolution_search.sql` | 08d346366ab878c6d5ddfc8bf912790b256b20673b4fe5210c26e4cf30ce9495 | supabase-role 1 |
| 543 | `20260923210000_vtid_04446_run_leases.sql` | f5014080e4edbac51fa6cd588cca55eb1b290f113eef3a7f41a511aff154d1cd | clean |
| 544 | `20260923220000_vtid_04441_memory_fact_forgotten.sql` | 48e1260e05947d2837338f50c127f08090469fa9aff67ccff83d8006a9c26e23 | supabase-role 1 |
| 545 | `20260923220000_vtid_04445_persona_voice_gender.sql` | bcb7ab2af93aedcb7662750f009c002da177674aa399af06bfc94b74f5c0b47d | clean |
| 546 | `20260924090000_vtid_04436_calendar_push.sql` | 23f7a0bacfd850117fbce6ac34afc3452b47c67c56532cfda404b556748743ea | auth-schema 2 |
| 547 | `20260924090000_vtid_04460_intent_ledger_embeddings_titan_v2.sql` | e91872b989e6578e34e328a16193cf5a5abd491fc6b2db795219117a15c130e2 | supabase-role 3 |
| 548 | `20260924100000_vtid_04449_outlook_contacts_app.sql` | e420109ca274c857b2afc983be9ff9781c81d2a656df8b71601e920f14d58f62 | clean |
| 549 | `20260924130000_vtid_04471_partner_account_model.sql` | e461e821499d84dcc59f53009ae47caf1ad29377ce409ec03c5b8b708591a0d0 | clean |
| 550 | `20260924150000_vtid_04478_partner_onboarding_engine.sql` | b5b9d53eee117b1654ee8fba3f8036c409c4363bead368f7b269e23695b64fb9 | supabase-role 2 |
| 551 | `20260924150000_vtid_04483_profile_health_summary.sql` | ee4220ca2d277526e8b4feba38e0f340efa93924dc31d23e40a5a293ef572e3f | supabase-role 1; auth-schema 1 |
| 552 | `20260924150000_vtid_04494_write_fact_one_current_fact.sql` | 4d64209895e6bba293b924d131d4d0a33a2c73f36cb6ecc82be394e765805741 | clean |
| 553 | `20260924170000_vtid_04489_index_boost.sql` | 2df60f90c1c15e5ae68028f5fd91471e134e649adc1428cb93ff1440f96f74fb | auth-schema 1; supabase-role 2 |
| 554 | `20260924180000_vtid_04500_autopilot_role_scope.sql` | 6ee93e185deb61b6dd616e9a4b67b675dee22e32eca2f04754042575a729316b | clean |
| 555 | `20260924190000_vtid_04498_index_standing.sql` | f62ce8d850544e51b95beaebbbdce80927f9172d5e48ef1178365bd4a597a84a | supabase-role 1; auth-schema 1 |
| 556 | `20260924190000_vtid_04503_autopilot_recommendation_action.sql` | 2edac6f3c0aefd4c043a9b8bc566cc89d2df14154f4483299a97cd061aa6c439 | clean |
| 557 | `20260924200000_vtid_04508_invite_attribution.sql` | da709cd449a199db2f79945fe6fa31f27fdd602eb55a1f07585dd74b4c8fcc01 | clean |
| 558 | `20260925120000_vtid_04561_one_role_truth.sql` | 0d08406a86a61e035056aaa4210da94d27a5dfec929426c91cd7b46ffc563cf8 | auth-schema 8 |
| 559 | `20260926110000_vtid_04624_operator_readonly_query.sql` | 780d8fd1bb8136dbbae11d51dd4e2f09d96f26fea7be95be450bed210981dabe | supabase-role 1 |
| 560 | `20260926120000_vtid_04657_activate_keeps_spec_snapshot.sql` | 2bae37c0a1faca290e0243087a8bc6bfb66a469fa685710933d6b483921576db | clean |
| 561 | `20260926130000_vtid_04641_ci_test_results.sql` | 76c51c3498a10bab97dad90fa32838ebcb89aa5581ac27a2dbed3697092eec34 | clean |
| 562 | `20260926140000_vtid_04666_recommendation_noise.sql` | 7f960c84a52e765f03f3eae787136ba412c162495dc575bade00924270d6df76 | clean |
| 563 | `20260926150000_vtid_04655_me_set_active_role_writes_role_preferences.sql` | fe5370b4ffe3d4e36bdc7a751309cf75a721d1f8ce1420d9b18402f8a92afe37 | auth-schema 3 |
| 564 | `20260926160000_vtid_04668_recommendation_priority.sql` | cd65a11345412d8ea13948085a32dad95342f5f1a1682fa8d9d8891889387d0c | clean |
| 565 | `20260926190000_vtid_04674_notification_type_controls.sql` | 66c844a81ab9f6210a4c438c698608400ef052827174d32fb094d18edaeb4f75 | supabase-role 5 |
| 566 | `20260928100000_vtid_04680_goal_plans_keep_calendar_clean.sql` | c62a3a894138fefd400cb732c3bc20a13875858ac035c3e636745a7be9186a3a | clean |
| 567 | `20260928200000_vtid_04716_autopilot_prompts_data_layer.sql` | 8026c2f5a9f1166b4991a51e9f1b897a76a60333ac2ae9cf97060e3f6503da89 | supabase-role 11; auth-schema 5 |
| 568 | `20260928200100_vtid_04718_overload_detection_data_layer.sql` | 77dcc433d0fdbcbab07c1c2b61c5f3d7f300afbfb442fcf9896c216a7c538df1 | supabase-role 20; auth-schema 20 |
| 569 | `20260928200200_vtid_04719_taste_alignment_data_layer.sql` | 9cf58af3759e3968dc1c9cbaa2ca460d810c0556e7838cbbfc1d7ba9f7f23364 | auth-schema 26; supabase-role 29 |
| 570 | `20260928200300_vtid_04720_preference_modeling_data_layer.sql` | 4871438d45e7a0af72f077521114d39f35d8bdc687f5ce9d8a3821ce269d2f84 | auth-schema 31; supabase-role 34 |
| 571 | `20260928200400_vtid_04717_risk_mitigations.sql` | 71f6d4f6d8cd339c2ce54ea1ecb396d6cd846a15bbf042d043f3e1000ec24c06 | auth-schema 5; supabase-role 7 |
| 572 | `20260928200500_vtid_04716_feature_functions_no_anon.sql` | 6518a44a15dccd97fd9e981d4015d988e1d82797635f22c06e0d1ce9100367f3 | clean |
| 573 | `20260929120000_vtid_04740_referrer_on_click_anonymous_buyers.sql` | a7f29eca66d73c581bd8f31c81d80f3f705f935502e23e12c81cf2675fddd967 | clean |
| 574 | `20260929120100_vtid_04741_recommendation_commission_hold.sql` | b438ea9b6a421b9e82b91bfdaac3f4cdb7b2762fa78f5f7620cc6c44ee42ab59 | clean |
| 575 | `20260929120200_vtid_04740_product_orders_tenant_nullable.sql` | d1afe17a7e5991b3f0b35248d8ebd7b5945083622289db0554288721459cced3 | clean |
| 576 | `20260929120300_vtid_04741_commission_confirm_reverse_functions.sql` | b453787c2a5fbe470e8224a329892f2c141073ca04e9e98d86e4b55b5c825672 | supabase-role 2 |
| 577 | `20260929120400_vtid_04741_confirm_commission_order_lock_exclusions.sql` | 8a43e501f2ea63e51c1425d7b9cdcda02d54a51bf1d78d8d87e9bb957df0fd17 | clean |
| 578 | `20260929120500_vtid_04741_reverse_commission_order_recheck.sql` | 5169eb77b7fc0d7bbbff5be9b6cbbb4c948ef54e1bad6b6614aba31ecf432d92 | clean |
| 579 | `20260929120600_vtid_04741_confirm_commission_refresh_terms.sql` | 5fd308bb55f036cefc8795c92fdc2147a33b8419f74129162340634d3d6c550d | clean |
| 580 | `20260929120700_vtid_04740_product_clicks_select_own_only.sql` | 546b57373fdad889244539494fa768fe18aef0af80c96336cc4a4617499b60d8 | supabase-role 1; auth-schema 1 |
| 581 | `20261001100000_vtid_04754_jev_spend_and_shadow.sql` | cb07b26f018a4571a2f1896bba27dd6dbc1d65e1d34137bcb28a0a5a7b455937 | supabase-role 4 |
| 582 | `20261001120000_VTID_04762_audiobook_season0_prolog.sql` | ccfe6107b54dbc74150ff4b3238688268bf428a1922c79e2b6ac621ba63b74cb | clean |
| 583 | `20261001120000_vtid_04765_erase_user_data.sql` | 4371fb75d22e74d382814338dc2b8faa87f2bb0994415e19cc77ef1251ec0e3e | supabase-role 2 |
| 584 | `20261001120000_vtid_04769_supplier_go_live_lists_products.sql` | 001433cd1426646b8ab625e7615e7ca7a0708440775f446a2fbaf7fe2e4315ca | supabase-role 3 |
| 585 | `20261001120000_vtid_04776_voice_session_facts.sql` | 3fb461fe9e3a7ce0ed40c28584ab04faa7768c353ed8df30fde78bd18444ac95 | supabase-role 3 |
| 586 | `20261001130000_VTID_04763_audiobook_daily_reminder_claim.sql` | 0cf554fc303aee430837fc58d350a1f2419de4e5284c6ca9af573334c00f9fba | supabase-role 1 |
| 587 | `20261001140000_vtid_04783_discover_categories.sql` | e2b0b8169fbae94e80e264f3bf5d47a915faf7122b44be069a907f635d19cc05 | supabase-role 3 |
| 588 | `20261001140000_vtid_04790_deny_scope_name_contains.sql` | 227345ad7742e9571e07db0fe1483455ccc0af9d5202c2ff91ca1c0779436db6 | clean |
| 589 | `20261001160000_vtid_04798_memory_sensitivity.sql` | f3a03c8c4bff402c610a87f1d6ea97d7db385957c3867772f92b19f43064cb4f | clean |
| 590 | `20261001180000_vtid_04809_vtna_reward_ledger.sql` | 340c963f7fd6f577a006303563b0889a46b9b73d4ffc757745a04cb8c8b6ba84 | auth-schema 2; supabase-role 2 |
| 591 | `20261003100000_vtid_04859_founding_1000.sql` | 38f197d8f7dbca226d254065e430c7ad10e1f053062091aecda6b09a2a12a632 | auth-schema 3; supabase-role 4 |
| 592 | `20261003120000_vtid_04860_knowledge_docs_vtna_name.sql` | b3d15f1a8a63697d8380435ad914ef6b45fcdcf1a4220697254678e77dcd8a11 | clean |
| 593 | `20261003130000_vtid_04864_autopilot_completion_no_double_reward.sql` | c9da3430bbd8b613d7706b9b544cf1a16f0d62ed63f40bee0570a4f5aeb7b4d2 | supabase-role 2 |
| 594 | `20261003140000_vtid_04864_claim_invite_reward.sql` | 0df3546d7878bb9ae69fe6a7b5b3df164dd4ae8a8cfd62154327ddb604cbfad1 | supabase-role 1 |
| 595 | `20261004100000_vtid_04872_jev_member_quota.sql` | fb7363dccb5e5b583b3ed3f8253f2234a71166f1bca11772a8245f8067e4a13e | supabase-role 2 |
| 596 | `20261004110000_vtid_04868_plan_sparring_gate.sql` | 80bc587894c2efdfea3fbc44a9c7488afa46dbbea8e96e9ef952516ed48c26ff | supabase-role 14 |
| 597 | `20261004120000_vtid_04868_plan_sparring_hardening.sql` | 2eaec16934081fdf754eb831d95fdb806bd9c067cc03282077a005ba91cb3796 | supabase-role 3 |
| 598 | `20261004130000_vtid_04876_ops_attention_state.sql` | e29d4799bcc07f7889266dfe25a533497c5c856945b8fbd3b70145db6721b545 | supabase-role 1 |
| 599 | `20261005090000_vtid_04880_archive_nav_catalog.sql` | 3280487d9fcffd811c43a771e0fff20946e7f3d829cf321cf144a69b8fab603d | supabase-role 1 |
| 600 | `20261005100000_vtid_04878_claim_capped_reward.sql` | b0d386fdcd322664896a82629109b4a8b44cbc0fc7e8983ea1af991b6b8dc6ba | supabase-role 5; auth-schema 2 |
| 601 | `20261005100000_vtid_04886_ops_attention_acks.sql` | 664a9ca316f550083901508abc78620c6af0e24d78f82d4a361595d9e5e47d35 | supabase-role 1 |
| 602 | `20261005120000_vtid_04888_rule45_intents_profiles.sql` | 8a56299d907e8f6126bd55f46b95396fd9fc5fc2d21e293279265cb571782bd3 | supabase-role 1 |
| 603 | `20261005130000_vtid_04892_onboarding_coach.sql` | b1d1e4997d5bdf6a5c7006f00103f34ee4899646da6066e6276b90252421e3e5 | supabase-role 3; auth-schema 4 |
| 604 | `20261005130000_vtid_04895_partner_terms_lifecycle.sql` | 0e0eff8c36ec19959efdb642e46f316839c7e87a1d7cedcf45a930179d378abd | auth-schema 1; supabase-role 3 |
| 605 | `20261006120000_vtid_04909_partner_terms_german_binding.sql` | a7f395124ebb2cd40a4fc869616988085fba396e1d75b3aebf9d7e65544f50a3 | supabase-role 1 |
| 606 | `20261006140000_vtid_04915_community_event_host_and_time_sync.sql` | f62fa4265e31524ca4a30edbdf3f612780a4832546592c8cb329b11d789a84cc | clean |
| 607 | `20261006150000_vtid_04926_mention_notification_types.sql` | 635e469827ce49bfc370a520df71624f09bdff4aa22a28c0356195f8effd5a65 | clean |
| 608 | `20261007190000_vtid_04962_user_notifications_push_outcome.sql` | 0f6d31b2c1b59571b22390a0bae711cd0aea7c43559c893e1260aa5de10d32b2 | clean |
| 609 | `20261007200000_vtid_04965_live_room_reminder_calendar.sql` | 6c1675c6a9ccf53f1ec42b13b9f4215e581618b0ce791e6aaccc9933672465f3 | clean |
| 610 | `20261008100000_vtid_04968_mcp_oauth_client_info.sql` | 11696205580e48fe9501a7aeb43b7fac97b450ce47eeff54451ac2cd7c09fca9 | supabase-role 1; auth-schema 1 |
| 611 | `20261008120000_vtid_04975_operator_thread_engine.sql` | 06e2ed06e5c2c28c84078446cacdaaf8c17c79280be21a87ad7cf5a41ebfaa60 | clean |
| 612 | `20261008130000_vtid_04976_live_room_follows_host.sql` | 094de4ee43f72712f052d5703deb9fc50d3844552aec03e325309673498d6914 | clean |
| 613 | `20261008150000_vtid_04978_reminders_in_calendar.sql` | 622684510db9baf939cb26fb732d1738713e8cc957ee0988848d78b834801456 | clean |
| 614 | `20261008170000_vtid_04981_consume_credits_lockdown.sql` | ddf2a33abf8786089ec43c49916c65bfe574e3dfc61fc9fd65151cbd5f6885ba | supabase-role 1 |
| 615 | `20261008180000_vtid_04982_rewards_shop.sql` | 297c0f91175f9a1fc346dd15addc40f3c98a81fd8c8d19850891fecc97ceb7d3 | supabase-role 10; auth-schema 1 |
| 616 | `20261008190000_vtid_04988_earned_vtna_rewards_only.sql` | af0307efbc009fd28cf500ff221f0b07e2936229d7da67def58de9a5908fb816 | supabase-role 1 |
| 617 | `20261009090000_vtid_04994_subscription_dates_in_calendar.sql` | c691db8e842340cf46a7d029f6ae4cbfa27e39de910c92ecd804f9307a5440ec | clean |
| 618 | `20261009120000_vtid_05012_jev_gate_observability.sql` | bcc6fa37fa7323a63c5c746df30a0b978c42e31ce1851d1e1fd8b1236942eb8f | supabase-role 1 |
| 619 | `20261009180000_vtid_05006_kiro_mcp_confirmations.sql` | 30c5d9d14b1a7054dfc8c1c5494d8c357d06f692cc944e2e7988734128b1fe8e | clean |
| 620 | `20261010100000_vtid_04997_test_results_in_calendar.sql` | 6da5bdbab38c559b10e6b8b89ca1bb7e16c16900411408f6d4ef3f292e8a76d0 | clean |
| 621 | `20261010120000_vtid_05027_push_reach_active.sql` | ca38fbdcca66fa1ee186ff1e2f761decb9ef8d4d2a5db87f75712ca0463f354f | supabase-role 1 |
| 622 | `20261010130000_vtid_05029_email_fallback.sql` | 5464d2819b1261797b2384f8d5ec4ca92dcda0d445a6549495e1e85f7b117aad | clean |
| 623 | `20261010140000_vtid_05030_user_connections_token_grants.sql` | 538ad53962ca0bf53b4e2d2a51a8cc4686a922c743f0132b7dddce3b1937fa2d | clean |
| 624 | `20261010150000_vtid_04917_audiobook_source_type.sql` | ce873c2e5c51bd6f835a4625ec63e309594bcf24bad5d30876de8e356d385cef | clean |
| 625 | `20261010160000_vtid_05035_reward_shop_images_bucket.sql` | 9a3c7893b3405a8519e6de5f0a1adff8f15d5ecc0715fb8cd68de6c3082ef1be | storage-schema 2 |
| 626 | `20261010160000_vtid_05038_welcome_trigger_enrollment_restore.sql` | abb1d0527e6e700adf531444f9cb9e6c015dac3602cfc8363069eaec0ed83539 | clean |
| 627 | `20261010160000_vtid_05057_contacts_phone_matching.sql` | 58b31417905a741aaa1f228701e84a02256e7478fcd7437a04d4a196140b2c33 | auth-schema 3 |
| 628 | `20261010164100_vtid_05041_definer_functions_lockdown.sql` | c414921ab2e0b42d9ae9df4c319066409a6b9963477286a56a0c666da4dfe14c | supabase-role 1 |
| 629 | `20261010170000_vtid_05052_ci_welcome_greeting_health_exclude_test_accounts.sql` | 5cbaee85380dae83f6c16250490432fdd87945042efc9bf9c53e58da55e6f063 | supabase-role 1 |
| 630 | `20261010180000_vtid_05043_s3_membership_side_effect_guard.sql` | efba9d626cdfe188a2659e5b10255b9a841a513a6a00d3879ef4132c1de0a08b | clean |
| 631 | `20261010180200_vtid_05043_s3_switch_tenant_open_signup_only.sql` | 03820a442f96588991d61d1805290f1a71f354507113463dae6811d77bb9c32a | supabase-role 1; auth-schema 3 |
| 632 | `20261010190000_vtid_05055_partner_health_member_link_confirmation.sql` | 92098fbed3d511e0f7dabfbbfc1e153c66b5b5d5a46346f992f48a139228d148 | supabase-role 1 |
| 633 | `20261010210000_vtid_05065_kiro_runs.sql` | 0c142fea82ea77fa1db3bb58a9359eb4d7f254a1dd2137a921645972f7a2edcc | clean |
| 634 | `20261010220000_vtid_05068_kiro_run_reattach.sql` | 03795107025f1e2c263c0016b15d1ab15f0650d5d974c0521ddd524ae80d4592 | clean |
| 635 | `20261011090000_vtid_05067_operator_media.sql` | a8723fb02280a22a0bd057f7300d05cf96851be5f209b32a4d3f07eb2f6faf5d | clean |
| 636 | `20261012110000_vtid_05077_plan_version_planner_model.sql` | aae8526595137d842deae81a4f25e5cc83619946261851a29547187ba16d1185 | clean |
| 637 | `20261012160000_vtid_05088_ci_memory_health_speech_input.sql` | 03efde2879cbce4a553a60a4cc9d62ead0452daefc776da1d62ae0c7ee20a8ea | supabase-role 1 |
| 638 | `20261012180000_vtid_05095_phone_verification.sql` | 7cc64dc05bf572de6aba2584fb03f097a570a69be60e89d8d977eab56498e8f1 | supabase-role 4 |
| 639 | `20261012190000_vtid_05098_retire_duplicate_routines.sql` | 4adfc092fb3d6316fe0f8f5e0ba29c309754feaffa5d26321970500e2532c695 | clean |
| 640 | `20261012200000_vtid_05099_companion_messages.sql` | 5acfa7c2b2afdcc997f72fc0943866f9d58e0f06ab142613f2604c0a0dca92d5 | supabase-role 6; auth-schema 6 |
| 641 | `20261012210000_vtid_05103_routine_runner_claim.sql` | cc210f3a7c25efc7f8cd00b0db7d016be967ce74b6b33d46850c02bf015b1aaf | supabase-role 2 |
| 642 | `20261012235118_vtid_05118_welcome_discount_trigger_secret.sql` | e46a7a29dc0b5f6154228fc67e471a07c9494d2d17c75fc9c01fc0b6aad4929b | clean |
| 643 | `20261013090000_vtid_05125_memory_functions_revoke_migrate.sql` | 348455c39ce031db08f4b3ab694d71a24d5f39e1c02946422b9e54711aac2cec | clean |
| 644 | `20261013150000_vtid_05133_ai_connection_grants.sql` | 3d4383b1276cffaa32bc43f7982d3260d26557ec215e97b88bc93ac50d2be28a | auth-schema 11; supabase-role 8 |
| 645 | `20261013150000_vtid_05146_autopilot_overlap_hold.sql` | 690eb28d784a51cf41bc6ee7387c4f8577014b1cc764b657509bb701ce187b57 | clean |
| 646 | `20261013180000_vtid_05137_chat_push_coalescing.sql` | 395cbec1d078f4de342de9a6eeaf3c6baee2e2b5b000256abf739536eac14a4f | clean |
| 647 | `20261013190000_vtid_05141_phase3b_routine_seeds.sql` | ba52decbdc44c3478e2abe8d7aa24e51b17e53832af98f60400c48f35509aed2 | clean |
| 648 | `20261013200000_vtid_05143_unified_card_system.sql` | 066b6cc3db9d6f3840f4774ee44ee3bc5231faba9073baa4270eddf900b8d637 | auth-schema 5 |
| 649 | `20261013210000_vtid_05148_learn_outcomes_routine_seed.sql` | 57ab1a0f320389e423ad7256c978a00329360575112830567facf0610d60bd45 | clean |
| 650 | `20261013233000_vtid_05147_s_m_membership_role_lockdown.sql` | 85dca17e0a4ea12b3238fc1d44de4bbbc717f0704d8c95298f51cfe711498815 | auth-schema 8; supabase-role 1 |
| 651 | `20261014000000_vtid_05153_supplier_catalog_check_routine_seed.sql` | 98b2c86d1ea65f69f3d3ea9e0489320bbbe784712a24122fc29ebd0dbd374df1 | clean |
| 652 | `20261014000100_vtid_05149_tenants_default_platform_flags.sql` | 31a799173ade50e336caf593b4519ea6e264e94654660514702ca98bfff34071 | clean |
| 653 | `20261014000200_vtid_05149_signup_default_tenant.sql` | 07a1e4f8544228ac629e45b3f1ae133e95727f762072e7b37633f1a4cf7d5fc8 | auth-schema 1 |
| 654 | `20261014000300_vtid_05149_ci_tenant_isolation_health.sql` | 9db82f00cc46212e68e3818d830f18dede973e78952aab69eff4356be2829ec2 | auth-schema 1; supabase-role 1 |
| 655 | `20261014000400_vtid_05150_tenant_brand_pack.sql` | 322695ec08175f221d72fd4831a823cc1879386d42600f2439a5c71460288c0a | supabase-role 2 |
| 656 | `20261014000500_vtid_05150_provision_tenant.sql` | e6f99fb17aec4900f5797d0c98e5ef83661a2952816266dca7c021b03d087909 | auth-schema 2; supabase-role 1 |
| 657 | `20261014000600_vtid_05151_public_tenant_registry.sql` | f0aa892d00f0dca13164f146ec6bd8836f36fa00d19327bc7e3859d1bb6f4443 | supabase-role 2 |
| 658 | `20261014000700_vtid_05151_seed_legacy_tenant_landing.sql` | d0579f14291658e22c57f11d5003ad2f0ea14e388e1517814a511d58c5b9e200 | clean |
| 659 | `20261014100000_vtid_05158_erase_user_data_aurora_safe.sql` | ef1d2584d9c6a2e68ff18c083eb337415e2581ffb7bff34bd43299986c8a2246 | supabase-role 1 |
| 660 | `20261014100100_vtid_05158_health_store.sql` | c9b71c7ce8330e297abf547cb07447390dbc28495b4d20d3ac715ce1eb681435 | supabase-role 14; auth-schema 4 |
| 661 | `20261014100200_vtid_05161_health_sources.sql` | 13f388be4a9627f2ce2d8172063a0de45948801a9b6fb6d27ed4dc71652f0bc1 | auth-schema 1; supabase-role 5 |
| 662 | `20261014100300_vtid_05161_user_integrations_revoke_browser_writes.sql` | 69014143fdc3617f785d0baf59ee0fe40e26d6df8474b5f39842301d5ca7c981 | supabase-role 1; auth-schema 1 |
| 663 | `20261014120000_vtid_05156_revoke_wearable_samples_rpc.sql` | a9c1502ad734c2f7839908d670467f6cff20748e48fad23374f34ecf540df2cb | supabase-role 1 |
| 664 | `20261014130000_vtid_05167_activity_tiers.sql` | 7bf2270bae0050b30d6004ebcb6198173772708b1f77b6b9fc600fb95a59f02b | supabase-role 4 |
| 665 | `20261014140000_vtid_05168_index_movements.sql` | d81ae78120e83921f7294eeae36ff782a4521bb736314102128fa85dd1c34bc2 | auth-schema 3; supabase-role 8 |
| 666 | `20261014150000_vtid_05171_companion_wiring.sql` | bd1bf9a98333d5835d4ff00d67cc570afd2daac47d9022d3164bae2a994d018d | supabase-role 2; auth-schema 3 |
| 667 | `20261015150000_vtid_05205_welcome_team_claims.sql` | eaf5d50853e03633690a4077cf7c5831259765b364554e232b7ccb8eb980fc6d | auth-schema 1; supabase-role 2 |
| 668 | `20261015180000_vtid_05214_plan_sparring_policy_approval.sql` | a58bd37974235c7a3117c7f8bad7efbefdcfb0110c11e3b7d9863300805122f5 | supabase-role 8 |
| 669 | `20261021140000_vtid_05310_chat_send_reliability.sql` | face0555a218ea907b1332ee218a955613bb83a2e08dabe3efef636d174917d9 | clean |
| 670 | `20261021150000_vtid_05312_chat_viewing_presence.sql` | bb28aa17efbd505648af60a5d205d52e4e4dc656b59eecfc30225e9600163b2d | clean |
| 671 | `20261022090000_vtid_05309_chat_message_search.sql` | 82782d8017ce014ffe4376960ecafe97433d0d5546b5bf0d19033ce1e654d9dd | clean |
| 672 | `20261101100000_mt_packs_tenant_content_overrides.sql` | aee2715b4970df78d4184181e219785c62ab7b22d6502f397266f70081b9bdd7 | auth-schema 2; supabase-role 1 |
| 673 | `20261101110000_mt_launch_tenant_pack_intake.sql` | 46d4f110742b80fdbfa72e4280c4ace2a92d9233d93f790df8f963500c618899 | auth-schema 2; supabase-role 1 |
| 674 | `20261101110100_mt_launch_tenant_content_pipeline.sql` | 49f46aadda3c197700d949a60b44fcf1dbe64134d876c7876e2f4de3804a636a | auth-schema 2; supabase-role 2 |
| 675 | `20261102030000_vtid_05465_tenant_id_for_policies_is_member.sql` | c3d419f6fe4b2a10cc1b9305b98822b97b804ba6501c3809a6022f0dc232c2bc | supabase-role 2; auth-schema 3 |
| 676 | `20261102030100_vtid_05465_bare_policy_rewrite.sql` | 4f65798ee7ac06b4b1df04c86eb573cace380680dc10e7595f7a04b97cfa1f15 | supabase-role 32 |
| 677 | `20261102030100_vtid_05465_bare_policy_rewrite_rollback.sql` | 50d7a5245150dedcdbd0b154e440708c2c26153a224bd4349976350fb42495a6 | supabase-role 32 |
| 678 | `20261102031000_vtid_05466_membership_unification_rollback.sql` | 9e54a7f2068edaba389eb5bb9866ddb12058c6b753cea18fea0bac0f4ecf0137 | clean |
| 679 | `20261102031000_vtid_05466_user_tenants_canonical.sql` | 0fd7fa3bd4df05e4de15d771fee9070af632fb04db94623c10ef69d8bf2ea0e8 | auth-schema 1; supabase-role 1 |
| 680 | `20261102031100_vtid_05466_memberships_view_dualwrite.sql` | 2c6567d13bbeae1aaf4a8943c4daa3d60359803de6a1edcbd73725770c5e5161 | supabase-role 1 |
| 681 | `20261102031200_vtid_05466_membership_drift_report.sql` | 240f74978beb1eba03da07546630c23812b9c99b11ad7fdedb493433570c91dd | supabase-role 3 |
| 682 | `20261102032000_vtid_05464_access_token_hook_shadow.sql` | 3d74da4be6482ea76b6c648d8234f78d194b288cacd0bc0ccf4f7faaeb512659 | clean |
| 683 | `20261102032000_vtid_05464_access_token_hook_shadow_rollback.sql` | becd6c76c1de9e27ab74445148d9fa3eb4739eab4c2ce9e668275a5e5ae0835b | clean |
| 684 | `20261102032100_vtid_05464_tenant_claim_mismatch_log.sql` | f016953449fa94a4d27b4ad2f492528fb8ed1e61340c726dbaedfd161a5d15a1 | supabase-role 1 |
| 685 | `20261102033000_vtid_05467_role_source_rollback.sql` | d5b52f7eddd914d4c1a927e4f68040ac44b76ac906bff852fd954190c35b9a21 | auth-schema 17 |
| 686 | `20261102033000_vtid_05467_single_role_source.sql` | b0b2ae559b54645fc82bbc8b2dd8a12051825e2fffaf7fb9f1708ecaa2110786 | auth-schema 11; supabase-role 3 |
| 687 | `20261102033100_vtid_05467_fix_bootstrap_admin_user.sql` | 9622bbb3471fa717ced9cdaab3c4f39b4b571595be94f2a0e41a0450bacdb3a6 | supabase-role 1; auth-schema 6 |
| 688 | `20261102040000_vtid_05571_orphan_analysis.sql` | 7f429e15af4c6392cba3a697d8d12a22751624a3b6cd94c98018356b8941e13a | clean |
| 689 | `20261102040100_vtid_05571_orphan_quarantine_snapshots.sql` | 1d52cb81d07324d3e96ed3559e2975c470290cb933ec1d054fa0afaaf26125fe | clean |
| 690 | `20261102040200_vtid_05571_orphan_move_logic.sql` | 2e127aaa19f4abf3e1946b178f6f11bc6c5c0e752c4f7fcf6327f137523119a5 | clean |
| 691 | `20261102040300_vtid_05571_orphan_cleanup_rollback.sql` | 655d28ea5854eada83f9b5a3d3277a086e041065c15b52569a21c044896f3506 | clean |
| 692 | `20261102040300_vtid_05571_orphan_cleanup_run.sql` | 51fda3e5ca5499186ddeac22fff397adf90b4097ec363eb314581674e5e102a8 | clean |
| 693 | `20261102040400_vtid_05571_writer_fallback_rollback.sql` | 71f066a9654f0595a33a7107e2842723cc8f9c049feca84350f238d12b91f0cc | auth-schema 31 |
| 694 | `20261102040400_vtid_05571_writer_repoint.sql` | abf4b4f395270f67bdfc5faa09486ab011337fee6432769f5b9d0b1ea1e253f8 | auth-schema 31; supabase-role 1 |
| 695 | `20261102041000_vtid_05570_memfacts_merge_functions.sql` | 7591545f82d712bf060a4e922454e6d884854ad2606ba5127fe8576e2260cfce | supabase-role 2 |
| 696 | `20261102041100_vtid_05570_memfacts_merge_rollback.sql` | 5f191131ad673d8a140318352f3d96f21c535b65674f273c13eb6c037f8328b1 | clean |
| 697 | `20261102041200_vtid_05570_memfacts_merge_run.sql` | 8f7a5547ee909c76815c678447ae57b95e7b23c75aa3d15f03bd40d8eff25b35 | clean |
| 698 | `20261102042000_vtid_05572_profiles_tenant_backfill_fn.sql` | 51d8f38571a8d11b8f9a3181db53996f0a9c6f3f009861254188b00cbcdf8838 | supabase-role 2 |
| 699 | `20261102042100_vtid_05572_profiles_tenant_backfill_run.sql` | 70d802c24d5c3c7ff8177ae4253b3206caf258876cb8acac59ce0893dcd11185 | clean |
| 700 | `20261102043000_vtid_05569_hot_tables_tenant_not_null_assert.sql` | aec3ed0f54261e376ddf2f8ad61f71f2b861a16df3c4ca1d9b5673619f3b4640 | clean |
| 701 | `20261102043100_vtid_05569_hot_tables_tenant_not_null_assert_rollback.sql` | 682213c8037791f07f1b79f093a7d8bb2d4c0ef730e8e1564cde7c962e995bdc | clean |
| 702 | `20261102050000_vtid_05576_chat_messages_scope.sql` | 46e4c40646700a94f25b96f1ed7d1b834593a9e9f9269b7d3f38872084494d68 | clean |
| 703 | `20261102050100_vtid_05576_send_message_rpcs.sql` | c151352c7703e64e090348b6d8f66a8e51adfc4ed77ad58115f9b23a9e1481b7 | supabase-role 2; auth-schema 1 |
| 704 | `20261102050200_vtid_05576_chat_messages_lockdown.sql` | d7aa3c4b06bd82ed9a0de79d8a28b180b6d984b71eda178bb67eb51a4d16f5ab | auth-schema 4; supabase-role 1 |
| 705 | `20261102051000_vtid_05582_network_visible_profile.sql` | 5e04d6b5164eb4c947a10c81afbf6979fc08a29f3fa988e8e6bca59f8210c5b5 | supabase-role 2 |
| 706 | `20261102051100_vtid_05582_connection_rpcs.sql` | 533907c3c4a8b1ecdd54770da257f93454979b81b0c4088105b2757f015d0207 | auth-schema 2; supabase-role 2 |
| 707 | `20261102052000_vtid_05573_legacy_messages_snapshot_freeze.sql` | e83cfa2f54a89154bfc06e2eb68ca61a0227e493cde74ae89227b764efbb0d67 | clean |
| 708 | `20261102052100_vtid_05573_legacy_messages_functions.sql` | 5f698fc25c97acebc98b14f93f39a363b1c9c9cf55690e81c474637fe93287ff | supabase-role 1 |
| 709 | `20261102052200_vtid_05573_legacy_messages_migrate_run.sql` | bbfe09c0befbb1b6c03d81c55f036300f3984b6e66c36848c5b54a402dddae04 | clean |
| 710 | `20261102053000_vtid_05575_daily_matches_scope.sql` | 1ea0ed93e45f431a50270e4752a1c46445f0e3480e6aa9cf046847d59dc8aad3 | clean |
| 711 | `20261102053100_vtid_05575_daily_matches_guard.sql` | 8dc26350815c47f1957b468c7f826b88d636d46421e75bc4827dbc91290f7c79 | supabase-role 3; auth-schema 1 |
| 712 | `20261102053200_vtid_05575_intent_matchers_scope.sql` | 96bd3fbd7afb38fb2b7d96080b1aa5f04d39be35ffcb3bd9ba1c57288325a8a3 | supabase-role 1 |
| 713 | `20261102054000_vtid_05579_chat_groups_scope.sql` | 3d574d0e8a893c6bbbd67320eb68c7eedefd9248303cf7fe68d42c1ccc92e174 | clean |
| 714 | `20261102054100_vtid_05579_network_group_rpcs.sql` | 09f3bdf8aeecad959a8e4b02a9c50661b58097d6e381496794122932a136e802 | supabase-role 4; auth-schema 2 |
| 715 | `20261102054200_vtid_05579_chat_groups_rls.sql` | 6637962ec76cd944dc791f8b5d8bc59edb21acf660fb642c6bb0b1d46ff86703 | auth-schema 2 |
| 716 | `20261102070100_vtid_05491_mt_tenant_admin_p2_moderation.sql` | 05177e8e6b5ed11681cb950ed70e25bf775b2e48c4e953ba89464139dfae06e4 | supabase-role 2; auth-schema 2 |
| 717 | `20261102070150_vtid_05491_mt_tenant_admin_p3_moderation.sql` | 2cbd3b041d82360df609c148cabcadc869441c8aab74bad51a47eb25b0960b5b | supabase-role 2; auth-schema 2 |
| 718 | `20261102070300_vtid_05493_mt_tenant_deactivate.sql` | b7a1bb9e4f575c58638ec33455b58a37bd70290d0c752ce2a961f09cd2d3840b | supabase-role 2 |
| 719 | `20261102070350_vtid_05493_mt_tenant_archive_switch.sql` | 938ef34ec43936c00f2c69f83e18803a3bfbdd8f648857f92aac82eb9d260c11 | supabase-role 2; auth-schema 3 |
| 720 | `20261102070600_vtid_05491_mt_moderator_tenant_scope.sql` | e8b9813a1a24298e492ce389593e9e41021e5ddb315e7db0fcf1516fa92e645b | supabase-role 4; auth-schema 8 |
| 721 | `20261102080000_mt_packs_knowledge_docs_tenant_id.sql` | 85dafe9d27c18a80eeb49123401623dd954a971436545570c3c428a213f83ecf | clean |
| 722 | `20261102120000_vtid_05488_supplier_tenant_relationships.sql` | d8a29aade2531144426b9e2ae7e09ce1b01fc66dd6865ca5c6df3dc9f02691f8 | auth-schema 1; supabase-role 4 |
| 723 | `20261102120100_vtid_05488_products_distribution.sql` | f2b87d21e33f8bc2bcdbaae04f26a4612bcaa26996c01e00aac90aa379459baa | clean |
| 724 | `20261102120200_vtid_05488_partner_tenant_backfill.sql` | d41897b54049333691aef1be93b702c4c155b6ffc9b896ceecc13a2dcf442149 | supabase-role 1 |
| 725 | `20261102120300_vtid_05488_products_merchants_tenant_rls.sql` | c7ef9fc0f250d9d62832cf77e9a7a108df664d3a7b9b3e0fb7e8adfc75329099 | supabase-role 3; auth-schema 2 |
| 726 | `20261102130000_vtid_05595_health_home_tenant_column.sql` | 0fbadf00b1d1b602b3b8527a959d6bf46de2966aa2d9edd4d5e6bc293a0df681 | clean |
| 727 | `20261102130100_vtid_05595_health_home_tenant_resolver_backfill.sql` | b1a4813541e41d3960afad01337952604c3df0010c4c4506011d6814147eacbb | supabase-role 2 |
| 728 | `20261102140000_vtid_05507_mt_tenant_domains.sql` | 5cfa40dcce00fddd8af343459114dbbee7962c1d5a8c0205af9d43a7356b8c73 | supabase-role 1 |
| 729 | `20261102140100_vtid_05507_mt_resolve_tenant_host.sql` | 0056ae296448c7d7ee070368ccef6d070593e938f1bb417d45db3ef239ca4cad | supabase-role 1 |
| 730 | `20261102141000_vtid_05506_mt_provision_erp_request.sql` | dfe1cb58de4a46f1754a0fb33d3811defb389f3a65b30780bccd65923e4f87ca | auth-schema 2; supabase-role 2 |
| 731 | `20261102141100_vtid_05506_mt_isolation_health_by_tenant.sql` | d09774523ea05682b1780b37e228ba4d9ca4651c80d761f4cf72869a83a8f5db | auth-schema 1; supabase-role 1 |
| 732 | `20261105170000_live_room_cohost_authz.sql` | 83311f09614ae58d227cf92824d481cc9ff5e86ae1a5d73695850aac9c8e200b | supabase-role 2; auth-schema 15 |

## Excluded

| Index | File | sha256 (origin/main blob) | Reason |
|---|---|---|---|
| X1 | `20261102052300_vtid_05573_legacy_messages_drop.sql` | 5256d291fffe36342fb70198bb29dd15014918eff3292be552644f243222c166 | Held and excluded. It drops the four legacy messenger tables (`messages`, `message_threads`, `global_messages`, `global_message_threads`). Its header says to apply only after the gateway and v1 stop reading those tables, with the owner's approval. Handover B2 excludes it from every apply list. Lint: clean. |

## Data-fixups (outside the top-level apply path, not counted in 732)

These are data-only fixes in `supabase/migrations/data-fixups/`. The owner decides whether any of them joins the apply set. They are not in the index above.

| Index | File | sha256 (origin/main blob) | Lint findings |
|---|---|---|---|
| D1 | `20260502090500_data_fixup_reset_FB_000032_to_spec_ready.sql` | 7359d06f6caf8f0b2cc8e180b66f54f1c1b3f3ba91b5e841dc4c6fe648d2f240 | clean |
| D2 | `20260503000500_data_fixup_FB_000032_proposed_files.sql` | 72ce1c4b268a17e7ce37937e19e9ee2443985f9a8eba14124d23708d4cfc1d84 | clean |
| D3 | `20260524040000_VTID_03039_ledger_registration.sql` | 6b9f25c121e3188f48bf27cf6a2f179e1acadbf4f06b5d8ce83c60fbbb204a69 | clean |
| D4 | `20260821110000_VTID_03695_seed_missing_locale_content.sql` | 0b7e8d1833a49b1305145b0fe59b82f691895fdc55f25dc1a787e5f156a948a7 | clean |
| D5 | `20260924210000_VTID_04519_nav_catalog_dead_home_routes.sql` | 2277102b05354c6a5df62bf0bcc8af0c64a1576f1e3f7e881f5176468fd15518 | clean |
| D6 | `20260926140100_vtid_04666_reject_noise.sql` | cb97d13656f36ab81e1376fc43acf1d302ad7cfa1695567071f97cae6c1b4043 | clean |
| D7 | `20260928100100_vtid_04680_cancel_generated_goal_plan_entries.sql` | d9c934fcba371c3cbaf5cf932fb6cd25ad4fbc0bf92d8a2ad9914b212d2b27ba | clean |
| D8 | `20261003120000_vtid_04857_jev_community_budgets.sql` | 6529438a318cfed580c5869376b6dbdba92c31dd3256b34782aa99b35b86604d | clean |
| D9 | `20261005120100_vtid_04888_rule45_cleanup.sql` | c27fa1e0a5c010ab93aec1b82f135ddf7b55338cacdbfff449cc557cae60fb16 | clean |
| D10 | `20261009200000_vtid_05010_voice_diary_episode_repair.sql` | d80410c0146b75b2fc9cb8cf7d02ced0699727b3ab6a83ac854271d97630d7bc | clean |
| D11 | `20261010180100_vtid_05043_s3_backfill_drifted_memberships.sql` | f6488ca0263d1b9155d238060dbdd9a8998796586f9527c97ca5f635893bdfec | auth-schema 4 |
| D12 | `20261012214500_vtid_05124_delete_orphan_memberships.sql` | 2f002cf57cd661be6a6173d3a15073040e86a9c3b99270a2e944aabdf8d64911 | auth-schema 2 |

## Recheck

Run from the repo root at the commit above. The first command checks the hashes of the 732 candidates. The second confirms the count.

```
awk -F'|' '/^\| [0-9]+ \| `/ {f=$3; h=$4; gsub(/[ `]/,"",f); gsub(/ /,"",h); print h"  supabase/migrations/"f}' docs/validation/VTID-05023/migration-order.md | sha256sum -c --quiet && echo "732 hashes ok"
```

```
grep -cE '^\| [0-9]+ \| `' docs/validation/VTID-05023/migration-order.md   # expect 732
```

