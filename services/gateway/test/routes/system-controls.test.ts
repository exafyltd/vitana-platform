import express from 'express';
import request from 'supertest';
import systemControlsRouter from '../../src/routes/system-controls';
import * as systemControlsService from '../../src/services/system-controls';

const app = express();
app.use(express.json());
app.use('/api/system-controls', systemControlsRouter);

// Basic mock error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.status(500).json({ error: 'Internal Server Error' });
});

jest.mock('../../src/services/system-controls');

describe('System Controls Routes', () => {
  const mockGetSystemControl = systemControlsService.getSystemControl as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 200 and the control data when found', async () => {
    const mockData = { key: 'vitana_did_you_know_enabled', enabled: true };
    mockGetSystemControl.mockResolvedValue(mockData);

    const response = await request(app).get('/api/system-controls/vitana_did_you_know_enabled');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockData);
    expect(mockGetSystemControl).toHaveBeenCalledWith('vitana_did_you_know_enabled');
  });

  it('returns 404 when the control is not found', async () => {
    mockGetSystemControl.mockResolvedValue(null);

    const response = await request(app).get('/api/system-controls/missing_key');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'System control not found' });
    expect(mockGetSystemControl).toHaveBeenCalledWith('missing_key');
  });

  it('returns 500 when the service throws an error', async () => {
    mockGetSystemControl.mockRejectedValue(new Error('Service failure'));

    const response = await request(app).get('/api/system-controls/some_key');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal Server Error' });
  });
});