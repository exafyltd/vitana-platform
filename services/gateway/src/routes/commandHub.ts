import { Router, Request, Response } from 'express';
import fetch from 'node-fetch';
import { naturalLanguageService } from '../services/NaturalLanguageService';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  res.setHeader('Content-Security-Policy', "default-src * 'unsafe-inline' 'unsafe-eval'; script-src * 'unsafe-inline' 'unsafe-eval';");
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html><head><title>Command HUB</title><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui;background:#0a0a0a;color:#e0e0e0;height:100vh;overflow:hidden}#container{display:flex;height:100vh}#ticker{width:40%;border-right:1px solid #333;padding:20px;overflow-y:auto}#chat{width:60%;display:flex;flex-direction:column}#messages{flex:1;padding:20px;overflow-y:auto}#input-box{padding:20px;border-top:1px solid #333;display:flex;gap:10px}input{flex:1;padding:12px;background:#1a1a1a;border:1px solid #333;color:#e0e0e0;border-radius:4px;font-size:14px}button{padding:12px 24px;background:#0066cc;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px}button:hover{background:#0052a3}.message{margin-bottom:16px;padding:12px;background:#1a1a1a;border-radius:4px;border-left:3px solid #0066cc}.message.user{border-left-color:#00cc66}.event{margin-bottom:8px;padding:8px;background:#1a1a1a;border-radius:4px;font-size:12px;border-left:2px solid #666}.meta{font-size:11px;color:#666;margin-top:4px}.oasis-badge{display:inline-block;padding:2px 6px;background:#ff6600;color:#fff;border-radius:3px;font-size:10px;margin-left:8px}#status{position:fixed;top:10px;right:10px;padding:8px 12px;background:#1a1a1a;border-radius:4px;font-size:12px}.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}.status-dot.online{background:#00cc66}.status-dot.offline{background:#cc0000}
</style></head><body>
<div id="status"><span class="status-dot offline" id="sd"></span><span id="st">Connecting...</span></div>
<div id="container">
<div id="ticker"><h2 style="margin-bottom:16px;color:#0066cc">Live Events<span class="oasis-badge">OASIS</span></h2><div id="events"></div></div>
<div id="chat">
<div style="padding:20px;border-bottom:1px solid #333"><h2 style="color:#0066cc">Command Hub</h2><p style="font-size:12px;color:#666;margin-top:4px">Ask naturally | /help for commands</p></div>
<div id="messages"></div>
<div id="input-box"><input type="text" id="mi" placeholder="Type message..."><button id="sb">Send</button></div>
</div></div>
<script>
let seenIds=new Set();
async function fetchEvents(){
  try{
    const r=await fetch('/events');
    if(!r.ok)throw new Error('Failed');
    const events=await r.json();
    updateStatus(true);
    if(Array.isArray(events)){
      events.reverse().forEach(ev=>{
        if(!seenIds.has(ev.id)){
          seenIds.add(ev.id);
          addEvent(ev);
        }
      });
      if(seenIds.size>100){
        const arr=Array.from(seenIds);
        seenIds=new Set(arr.slice(-50));
      }
    }
  }catch(err){
    updateStatus(false);
  }
}
function updateStatus(on){
  document.getElementById('sd').className='status-dot '+(on?'online':'offline');
  document.getElementById('st').textContent=on?'Connected':'Disconnected';
}
function addEvent(ev){
  const d=document.getElementById('events'),e=document.createElement('div');
  e.className='event';
  const type=ev.topic||ev.event_type||'event';
  const msg=ev.message||ev.service||'';
  const time=ev.created_at?new Date(ev.created_at).toLocaleTimeString():'';
  const vtid=ev.vtid&&ev.vtid!=='UNSET'?' ['+ev.vtid+']':'';
  e.innerHTML='<strong>'+type+'</strong>'+vtid+'<div class="meta">'+msg+(time?' • '+time:'')+'</div>';
  d.insertBefore(e,d.firstChild);
  while(d.children.length>50)d.removeChild(d.lastChild);
}
function addMessage(txt,isUser){
  const m=document.getElementById('messages'),div=document.createElement('div');
  div.className='message'+(isUser?' user':'');
  div.textContent=txt;
  m.appendChild(div);
  m.scrollTop=m.scrollHeight;
}
async function send(){
  const inp=document.getElementById('mi'),msg=inp.value.trim();
  if(!msg)return;
  inp.value='';
  addMessage(msg,true);
  try{
    const r=await fetch('/command-hub/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg})});
    const d=await r.json();
    addMessage(d.response||d.text||'No response',false);
  }catch(e){
    addMessage('Error: '+e.message,false);
  }
}
document.getElementById('mi').addEventListener('keypress',function(e){if(e.key==='Enter')send()});
document.getElementById('sb').addEventListener('click',send);
fetchEvents();
setInterval(fetchEvents,3000);
</script>
</body></html>`);
});

router.post('/api/chat', async (req: Request, res: Response) => {
  const message = req.body?.message || '';
  if (!message.trim()) return res.status(400).json({ error: 'Empty message' });
  
  if (message.startsWith('/')) {
    const cmd = message.toLowerCase();
    if (cmd === '/help') return res.json({ response: 'Commands:\n/status /services /vtids /help\n\nOr ask naturally - powered by Gemini!' });
    if (cmd === '/status') return res.json({ response: `System:\n- Gateway: Online\n- AI: Gemini Enabled\n- Time: ${new Date().toISOString()}` });
    if (cmd === '/services') {
      try {
        const r = await fetch('https://oasis-operator-86804897789.us-central1.run.app/health/services');
        if (r.ok) {
          const data: any = await r.json();
          const lines = (data.services || []).map((s: any) => `- ${s.name}: ${s.status}`);
          return res.json({ response: `Services:\n${lines.join('\n')}` });
        }
      } catch (err) {}
      return res.json({ response: 'Service health unavailable.' });
    }
    if (cmd === '/vtids') return res.json({ response: 'Active: DEV-COMMU-0042 (Command HUB)' });
    return res.json({ response: `Unknown: ${message}` });
  }
  
  const response = await naturalLanguageService.processMessage(message);
  res.json({ response });
});

router.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'healthy', service: 'command-hub', version: '1.5.0', ai: 'gemini-enabled', timestamp: new Date().toISOString() });
});

export default router;
