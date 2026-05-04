import request from 'supertest';
import express from 'express';
import systemControlsRouter from '../../src/routes/system-controls';
import * as systemControlsService from '../../src/services/system-controls';

jest.mock('../../src/services/system-controls');

const app = express();
app.use(express.json());
app.use('/api/system-controls', systemControlsRouter);

describe('GET /api/system-controls/:key', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 200 and the control object if found', async () => {
    const mockControl = { key: 'vitana_did_you_know_enabled', enabled: true };
    jest.spyOn(systemControlsService, 'getSystemControl').mockResolvedValue(mockControl);

    const res = await request(app).get('/api/system-controls/vitana_did_you_know_enabled');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockControl);
    expect(systemControlsService.getSystemControl).toHaveBeenCalledWith('vitana_did_you_know_enabled');
  });

  it('should return 404 if the control object is not found', async () => {
    jest.spyOn(systemControlsService, 'getSystemControl').mockResolvedValue(null);

    const res = await request(app).get('/api/system-controls/missing_key');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'System control not found' });
    expect(systemControlsService.getSystemControl).toHaveBeenCalledWith('missing_key');
  });

  it('should return 500 on internal server error', async () => {
    jest.spyOn(systemControlsService, 'getSystemControl').mockRejectedValue(new Error('Internal'));

    const res = await request(app).get('/api/system-controls/error_key');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(systemControlsService.getSystemControl).toHaveBeenCalledWith('error_key');
  });
});