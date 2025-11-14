import { Router } from "express";
export const commandhubHotfix = Router();
commandhubHotfix.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"/><title>Command Hub — Scheduled</title><meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:24px}h1{margin:0 0 12px}.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}.card{border:1px solid #ddd;border-radius:12px;padding:14px;box-shadow:0 1px 3px rgba(0,0,0,.06)}.vtid{font-weight:600}.title{margin:6px 0 10px}.status{font-size:12px;color:#0a7;font-weight:600;text-transform:uppercase;letter-spacing:.3px}.err{color:#c00;white-space:pre-wrap}</style></head>
<body><h1>Command Hub — Scheduled</h1><div class="meta"><code>/api/v1/commandhub/board?limit=5</code></div><div id="root">Loading…</div>
<script>(async()=>{const r=await fetch('/api/v1/commandhub/board?limit=5');const t=await r.text();const root=document.getElementById('root');if(!r.ok){root.innerHTML='<pre class="err">HTTP '+r.status+'\\n'+t+'</pre>';return}const data=JSON.parse(t);if(!Array.isArray(data)||!data.length){root.textContent='No tasks';return}root.innerHTML='<div class="grid">'+data.map(d=>'<div class="card"><div class="vtid">'+(d.vtid||'')+'</div><div class="title">'+(d.title||'')+'</div><div class="status">'+(d.status||'')+'</div></div>').join('')+'</div>';})().catch(e=>{document.getElementById('root').innerHTML='<pre class="err">'+e+'</pre>';});</script>
</body></html>`);});
