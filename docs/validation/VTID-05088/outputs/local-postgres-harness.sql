create role anon; create role authenticated; create role service_role;
create table memory_facts(extracted_at timestamptz, fact_key text, superseded_by uuid, embedding text, embedding_updated_at timestamptz);
create table memory_items(created_at timestamptz, content text, embedding text, embedding_updated_at timestamptz);
create table memory_write_dlq(created_at timestamptz);
create table oasis_events(topic text, created_at timestamptz default now(), metadata jsonb);
create table automation_runs(automation_id text, started_at timestamptz);
create table memory_transcript_turns(created_at timestamptz default now());
\i supabase/migrations/20261012160000_vtid_05088_ci_memory_health_speech_input.sql
-- turn 1: delta fragments, each < 20 chars, sum > 20 -> counts
insert into oasis_events(topic,metadata) values
 ('orb.live.diag','{"stage":"input_transcription","session_id":"s1","turn_count":"1","text_preview":"wie geht es"}'),
 ('orb.live.diag','{"stage":"input_transcription","session_id":"s1","turn_count":"1","text_preview":"dir heute morgen"}'),
 ('orb.live.diag','{"stage":"input_transcription","session_id":"s1","turn_count":"2","text_preview":"ja"}'),
 ('orb.live.diag','{"stage":"input_transcription","session_id":"s2","turn_count":"0","text_preview":"ja"}'),
 ('orb.live.diag','{"stage":"turn_complete","session_id":"s1","turn_count":"1","text_preview":"xxxxxxxxxxxxxxxxxxxxxxxxx"}');
insert into oasis_events(topic,created_at,metadata) values ('orb.live.diag', now()-interval '2 days','{"stage":"input_transcription","session_id":"old","turn_count":"1","text_preview":"this is an old turn longer than twenty"}');
insert into memory_transcript_turns default values;
select (ci_memory_health()->>'user_speech_turns_24h') speech, (ci_memory_health()->>'transcript_turns_24h') turns, (ci_memory_health()->>'facts_written_24h') facts;
\i supabase/migrations/20261012160000_vtid_05088_ci_memory_health_speech_input.sql
select has_function_privilege('anon','ci_memory_health()','execute') anon_exec, has_function_privilege('service_role','ci_memory_health()','execute') sr_exec;
