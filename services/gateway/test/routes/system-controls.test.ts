import express from 'express';
import request from 'supertest';
import systemControlsRouter from '../../src/routes/system-controls';
import * as systemControlsService from '../../src/services/system-controls';

jest.mock('../../src/services/system-controls');

const app = express();
app.use(express.json());
app.use('/api/system-controls', systemControlsRouter);
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.status(500).json({ error: err.message });
});

describe('System Controls Routes', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/system-controls/:key should return 200 and the control when found', async () => {
    const mockControl = { key: 'vitana_did_you_know_enabled', enabled: true };
    jest.spyOn(systemControlsService, 'getSystemControl').mockResolvedValue(mockControl);

    const response = await request(app).get('/api/system-controls/vitana_did_you_know_enabled');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockControl);
    expect(systemControlsService.getSystemControl).toHaveBeenCalledWith('vitana_did_you_know_enabled');
  });

  it('GET /api/system-controls/:key should return 404 when not found', async () => {
    jest.spyOn(systemControlsService, 'getSystemControl').mockResolvedValue(null);

    const response = await request(app).get('/api/system-controls/missing_flag');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'System control not found' });
  });

  it('GET /api/system-controls/:key should return 500 on service errors', async () => {
    jest.spyOn(systemControlsService, 'getSystemControl').mockRejectedValue(new Error('Internal failure'));

    const response = await request(app).get('/api/system-controls/error_flag');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal failure' });
  });
});