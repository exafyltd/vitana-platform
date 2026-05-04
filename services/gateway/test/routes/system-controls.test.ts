import request from 'supertest';
import express from 'express';
import systemControlsRouter from '../../src/routes/system-controls';
import * as systemControlsService from '../../src/services/system-controls';

const app = express();
app.use(express.json());
app.use('/api/system-controls', systemControlsRouter);

describe('system-controls route', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should return 200 and the system control if found', async () => {
    jest.spyOn(systemControlsService, 'getSystemControl').mockResolvedValue({
      key: 'vitana_did_you_know_enabled',
      enabled: true
    });

    const response = await request(app).get('/api/system-controls/vitana_did_you_know_enabled');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      key: 'vitana_did_you_know_enabled',
      enabled: true
    });
  });

  it('should return 404 if the system control is not found', async () => {
    jest.spyOn(systemControlsService, 'getSystemControl').mockResolvedValue(null);

    const response = await request(app).get('/api/system-controls/missing_key');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'System control not found' });
  });

  it('should return 500 on internal error', async () => {
    jest.spyOn(systemControlsService, 'getSystemControl').mockRejectedValue(new Error('DB connection failed'));

    const response = await request(app).get('/api/system-controls/some_key');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
  });
});