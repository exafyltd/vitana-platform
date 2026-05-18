import request from 'supertest';
import express from 'express';
import router from '../../src/routes/diag';

const mountApp = () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1/diag', router);
  return app;
};

describe('diag routes (BOOTSTRAP-NOTIF-MESSENGER-DIAG)', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('GET /ping', () => {
    it('returns 200 with a JSON envelope (no auth required)', async () => {
      const res = await request(mountApp()).get('/api/v1/diag/ping');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.ok).toBe(true);
      expect(res.body.service).toBe('gateway-diag');
      expect(typeof res.body.now).toBe('string');
    });
  });

  describe('POST /notif-tap', () => {
    it('accepts a beacon and returns 204 (no auth required)', async () => {
      const res = await request(mountApp())
        .post('/api/v1/diag/notif-tap')
        .send({ event: 'boot', href: 'https://vitanaland.com/inbox?recipient=abc' });
      expect(res.status).toBe(204);
    });

    it('logs the beacon with the [NotifDiag] prefix so Cloud Run logs are filterable', async () => {
      const logSpy = jest.spyOn(console, 'log');
      await request(mountApp())
        .post('/api/v1/diag/notif-tap')
        .set('User-Agent', 'Mozilla/5.0 (Linux; Android 14; wv)')
        .send({ event: 'deep_link_detected', recipient: 'user-uuid' });
      expect(logSpy).toHaveBeenCalled();
      const line = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(line).toContain('[NotifDiag]');
      expect(line).toContain('event=deep_link_detected');
    });

    it('rejects oversized bodies with 413', async () => {
      const huge = 'x'.repeat(10 * 1024); // 10KB > 8KB cap
      const res = await request(mountApp())
        .post('/api/v1/diag/notif-tap')
        .send({ event: 'window_error', message: huge });
      expect(res.status).toBe(413);
      expect(res.body.error).toBe('body_too_large');
    });

    it('handles empty bodies gracefully', async () => {
      const res = await request(mountApp()).post('/api/v1/diag/notif-tap').send({});
      expect(res.status).toBe(204);
    });
  });
});
