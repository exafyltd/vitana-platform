import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const db = new PGlite();
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok  ', m); };
await db.exec(`
CREATE TABLE supported_locales(code text primary key); INSERT INTO supported_locales VALUES ('de'),('en'),('es'),('sr');
CREATE TABLE journey_checklist_topics (topic_id text primary key, curriculum_version text not null default 'v2', session integer not null, position integer not null check (position>=1), chapter_id text not null, display_label text not null, title text, short_description text, vitana_voice_script text, explanation_what_it_is text, explanation_user_benefit text, explanation_when_to_use text, explanation_try_this text, guided_practice_target text, practice_action_type text, completion_event text, unlock_rule text, safety_level text not null default 'standard', business_gate text check (business_gate is null or business_gate in ('curious','active','builder')), source_refs text[] not null default '{}', manual_path text, fallback_topic_id text, status text not null default 'draft' check (status in ('draft','published','disabled')), enabled boolean not null default true, updated_by_admin_id uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), UNIQUE (curriculum_version, session, position), CONSTRAINT journey_checklist_topics_session_check CHECK (session between 1 and 94));
CREATE TABLE journey_checklist_translations (topic_id text not null, locale text not null references supported_locales(code), display_label text, short_description text, explanation_what_it_is text, explanation_user_benefit text, explanation_when_to_use text, explanation_try_this text, source_version_id uuid, updated_at timestamptz not null default now(), vitana_voice_script text, source_sha text, primary key (topic_id, locale));
CREATE TABLE journey_checklist_versions (id uuid primary key default gen_random_uuid(), version_label text not null, curriculum_version text not null, status text not null default 'published', session_count int not null, topic_count int not null, snapshot jsonb not null, validation jsonb not null default '{}', is_current boolean not null default false, note text, published_by uuid, published_at timestamptz not null default now(), created_at timestamptz not null default now());
CREATE TABLE journey_checklist_audit (id uuid primary key default gen_random_uuid(), actor_admin_id uuid, action text not null check (action in ('create','update','reorder','disable','enable','publish','rollback','export','seed')), topic_id text, version_id uuid, changed_fields jsonb, detail text, created_at timestamptz not null default now());
CREATE TABLE user_guided_journey_state (user_id uuid primary key, mode text not null default 'guided', current_session int not null default 1 check (current_session>=1), completed_topic_ids text[] not null default '{}', updated_at timestamptz not null default now());
`);
// 94 sessions / 254 topics: sessions 1-4 = T251-T254 (1 topic), sessions 5..94 = T001..T250 (2-3 topics).
let tid = 1;
await db.exec(`INSERT INTO journey_checklist_topics(topic_id,session,position,chapter_id,display_label) VALUES ('T251',1,1,'basics','Start'),('T252',2,1,'basics','Plan'),('T253',3,1,'basics','Step'),('T254',4,1,'basics','Progress')`);
for (let s = 5; s <= 94; s++) {
  const n = s % 3 === 0 ? 2 : 3;
  for (let p = 1; p <= n && tid <= 250; p++) {
    const id = 'T' + String(tid++).padStart(3, '0');
    await db.query(`INSERT INTO journey_checklist_topics(topic_id,session,position,chapter_id,display_label) VALUES ($1,$2,$3,'basics',$1)`, [id, s, p]);
  }
}
await db.exec(`INSERT INTO journey_checklist_versions(version_label,curriculum_version,session_count,topic_count,snapshot,is_current)
  SELECT 'v2-test','v2',94,count(*),jsonb_agg(jsonb_build_object('topicId',topic_id,'session',session,'position',position,'chapterId',chapter_id,'displayLabel',display_label) ORDER BY session,position),true FROM journey_checklist_topics`);
await db.exec(`INSERT INTO journey_checklist_versions(version_label,curriculum_version,session_count,topic_count,snapshot,is_current) VALUES ('old','v2',94,1,'[{"topicId":"T001","session":5}]',false)`);
await db.exec(`INSERT INTO user_guided_journey_state(user_id,current_session) VALUES ('00000000-0000-0000-0000-000000000001',1),('00000000-0000-0000-0000-000000000002',5),('00000000-0000-0000-0000-000000000003',94)`);
const before = (await db.query(`select count(*)::int n from journey_checklist_topics`)).rows[0].n;
console.log('seeded topics', before, 'last id', tid - 1);

const sql = fs.readFileSync(process.argv[2], 'utf8');
await db.exec(sql);
const q = async (s) => (await db.query(s)).rows;
assert((await q(`select count(*)::int n from journey_checklist_topics`))[0].n === before + 6, 'six topics added');
assert((await q(`select max(session)::int m from journey_checklist_topics`))[0].m === 100, 'sessions now end at 100');
const first = await q(`select topic_id, session, chapter_id from journey_checklist_topics where session<=7 order by session`);
assert(first.map(r=>r.topic_id).join() === 'T255,T256,T257,T258,T259,T260,T251', 'Prolog T255-T260 are sessions 1-6, T251 moved to 7');
assert(first.slice(0,6).every(r=>r.chapter_id==='prolog'), 'Prolog topics carry chapter prolog');
assert((await q(`select session from journey_checklist_topics where topic_id='T001'`))[0].session === 11, 'T001 moved 5 -> 11');
const users = await q(`select current_session from user_guided_journey_state order by user_id`);
assert(users.map(u=>u.current_session).join() === '1,11,100', 'members: 1 stays 1 (gets the Prolog), 5 -> 11, 94 -> 100');
const v = (await q(`select session_count, topic_count, snapshot from journey_checklist_versions where is_current`))[0];
assert(v.session_count === 100 && v.topic_count === before + 6, 'current snapshot counts updated');
const snap = v.snapshot;
assert(snap.length === before + 6, 'snapshot has every topic');
assert(snap.slice(0,6).map(e=>e.topicId).join() === 'T255,T256,T257,T258,T259,T260', 'snapshot starts with the Prolog');
assert(snap[0].vitanaVoiceScript && snap[0].vitanaVoiceScript.startsWith('Schön, dass du da bist'), 'snapshot carries the German narration');
const live = await q(`select topic_id, session, position from journey_checklist_topics order by session, position`);
const snapPairs = snap.map(e=>`${e.topicId}:${e.session}`).sort().join();
assert(snapPairs === live.map(r=>`${r.topic_id}:${r.session}`).sort().join(), 'snapshot sessions match the draft table exactly');
assert((await q(`select snapshot from journey_checklist_versions where version_label='old'`))[0].snapshot[0].session === 5, 'non-current versions untouched');
const en = await q(`select topic_id, display_label, vitana_voice_script from journey_checklist_translations where locale='en' order by topic_id`);
assert(en.length === 6 && en.every(r=>r.vitana_voice_script && r.vitana_voice_script.length > 300), 'English rows with narration for all six');
for (const r of snap.slice(0,6)) assert(r.vitanaVoiceScript.length < 2800, `${r.topicId} narration fits one Polly chunk (${r.vitanaVoiceScript.length} chars)`);
assert(!/\b(Sie|Ihr|Ihnen)\b/.test(snap.slice(0,6).map(e=>e.vitanaVoiceScript+e.displayLabel).join(' ')), 'German narration is du-form');

// Idempotent
await db.exec(sql);
assert((await q(`select count(*)::int n from journey_checklist_topics`))[0].n === before + 6, 're-run adds nothing');
assert((await q(`select max(session)::int m from journey_checklist_topics`))[0].m === 100, 're-run shifts nothing');
assert((await q(`select current_session from user_guided_journey_state order by user_id`)).map(u=>u.current_session).join() === '1,11,100', 're-run leaves members alone');
assert((await q(`select jsonb_array_length(snapshot) n from journey_checklist_versions where is_current`))[0].n === before + 6, 're-run leaves the snapshot alone');
console.log('ALL MIGRATION CHECKS PASSED');
