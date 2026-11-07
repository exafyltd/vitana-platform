import http from 'node:http';
const seen = [];
const b = http.createServer((req, res) => { seen.push({ host: req.headers.host, privateToken: req.headers['private-token'], authorization: req.headers.authorization }); res.end('{}'); });
await new Promise((r) => b.listen(0, '127.0.0.1', r));
const bPort = b.address().port;
const a = http.createServer((req, res) => { res.statusCode = 302; res.setHeader('location', `http://localhost:${bPort}/landed`); res.end(); });
await new Promise((r) => a.listen(0, '127.0.0.1', r));
const aPort = a.address().port;
const headers = { 'private-token': 'SECRET-TOKEN-VALUE', authorization: 'Bearer SECRET-BEARER' };
for (const redirect of ['follow', 'manual']) {
  seen.length = 0;
  const r = await fetch(`http://127.0.0.1:${aPort}/start`, { headers, redirect });
  console.log(`redirect=${redirect}: status=${r.status} requests to the OTHER origin: ${seen.length}`, JSON.stringify(seen));
}
a.close(); b.close();
