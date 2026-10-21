-- VTID-04888 / VTID-04889 ledger rows (title, status, sparring record). The Supabase connector's writes time out
-- in the building session, so this is applied with RUN-MIGRATION.yml like the migration itself. Idempotent.
BEGIN;
UPDATE public.vtid_ledger
   SET title = 'Rule 45: test/service accounts excluded from Find-a-Match RPCs, matchmaker fallback and member profile lists',
       metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
         'db_applied', '2026-10-07 via RUN-MIGRATION.yml (migration + data fix-up), verified read-only',
         'pr', 'exafyltd/vitana-platform#3914')
 WHERE vtid = 'VTID-04888';
UPDATE public.vtid_ledger
   SET title = 'D4: generate-enhanced-recommendations on Bedrock only; retire generate-recommendations (Gemini)',
       status = 'in_progress',
       spec_status = 'approved',
       metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
         'sparring', jsonb_build_object('tier', 'session', 'record', 'docs/validation/VTID-04889/plan-sparring.md',
                                        'rounds', 2, 'verdict', 'converged',
                                        'plan_hash', 'dee0fbeeffac31e637d6dbe0fc6e13aaf373bf12908ec62820bf9ffb90005c20',
                                        'owner_approval', '2026-10-05'),
         'pr', 'exafyltd/vitana-v1#1228',
         'merged_commit', '899d75871b3e201814c793328245571fd8609fd0',
         'staging_verified', 'STAGING-VERIFY community-app run 37294290801',
         'edge_deploy', 'generate-enhanced-recommendations v284, 2026-10-07')
 WHERE vtid = 'VTID-04889';
COMMIT;
