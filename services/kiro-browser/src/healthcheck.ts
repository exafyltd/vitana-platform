// VTID-05070: container health check (ECS). Healthy when the HTTP server answers; the browser's own
// state is on /alive (browser.ok) and never takes the runner down (the container is non-essential).
import http from 'http';

const port = Number.parseInt(process.env.KIRO_BROWSER_PORT ?? '', 10) || 8090;
http.get({ host: '127.0.0.1', port, path: '/alive', timeout: 4000 }, (res) => process.exit(res.statusCode === 200 ? 0 : 1))
  .on('error', () => process.exit(1))
  .on('timeout', () => process.exit(1));
