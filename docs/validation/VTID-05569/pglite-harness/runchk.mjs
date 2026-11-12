import { PGlite } from '/projects/sandbox/.tools/pglite/node_modules/@electric-sql/pglite/dist/index.js';
import { readFileSync } from 'node:fs';
const [,, ...files]=process.argv;
const db=new PGlite();
await db.exec(`DO $$ BEGIN CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid primary key, raw_user_meta_data jsonb); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$; CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;`);
for (const f of files){
  const s=readFileSync(f,'utf8');
  try{ const r=await db.exec(s); const out=r.filter(x=>x.fields&&x.fields.length); if(out.length){ console.log('## '+f.split('/').pop()); for(const o of out){ console.log(o.fields.map(x=>x.name).join(' | ')); for(const row of o.rows) console.log(Object.values(row).join(' | ')); console.log(''); } } else console.log('loaded '+f.split('/').pop()); }catch(e){console.log('ERROR in '+f+': '+e.message); process.exit(1);}
}
