const fs=require('fs'),path=require('path');
const SRC=path.resolve('src');
const RE=/commission|payout|\bearnings?\b|\bearned\b|_earned|earned_/i;
const strip=s=>s.replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|[^:'"`])\/\/.*$/gm,'$1');
const refs=s=>strip(s).split('\n').map((l,i)=>[l.trim(),i+1]).filter(([l])=>RE.test(l)).map(([l,n])=>n+': '+l);
const ls=d=>!fs.existsSync(d)?[]:fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>{const p=path.join(d,e.name);return e.isDirectory()?ls(p):(e.name.endsWith('.ts')&&!e.name.endsWith('.d.ts')?[p]:[])});
const m=(d,re)=>ls(d).filter(f=>re.test(path.basename(f)));
const files=[path.join(SRC,'services/feed-ranker.ts'),path.join(SRC,'services/limitations-filter.ts'),path.join(SRC,'routes/discover-search.ts'),...m(path.join(SRC,'routes'),/^discover-feed/),...m(path.join(SRC,'services'),/^user-health-context/),...m(path.join(SRC,'services/orb-tools'),/^marketplace-/),...ls(path.join(SRC,'services/recommendation-engine')),...ls(path.join(SRC,'services/shopping-agent'))];
console.log('files',files.length, files.every(f=>fs.existsSync(f)));
let bad=0; for(const f of files){const r=refs(fs.readFileSync(f,'utf8')); if(r.length){bad++;console.log(f,r)}}
const v=fs.readFileSync('../vaea/src/matcher/catalog-matcher.ts','utf8'); console.log('vaea',refs(v.slice(v.indexOf('const scored'))));
const planted='const score = rating * 0.5 + product.commission_rate;\nrows.sort((a, b) => b.recommendation_commission_rate_override - a.x);\nif (merchant.payout_amount_minor > 0) boost += 1;\nconst w = earnings[p.id] ?? 0;\nweight += item.commission_percent;';
console.log('planted',refs(planted).length);
console.log('clean',refs("// commission must never be used here\n/* payout is out of scope */\nconst note = 'preference learning';\nconst learned = true; const yearning = false;\nfetch('https://example.test/path');"));
console.log('bad',bad);
