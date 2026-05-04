import request from 'supertest';
import express from 'express';
import systemControlsRouter from '../../src/routes/system-controls';
import * as systemControlsService from '../../src/services/system-controls';

jest.mock('../../src/services/system-controls');

const app = express();
app.use(express.json());
app.use('/api/system-controls', systemControlsRouter);

// Basic error handler to catch errors during tests
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.status(500).json({ error: 'Internal server error' });
});

describe('System Controls Routes', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/system-controls/:key - returns 200 and the control if found', async () => {
    const mockControl = { key: 'vitana_did_you_know_enabled', enabled: true };
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(mockControl);

    const response = await request(app).get('/api/system-controls/vitana_did_you_know_enabled');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockControl);
    expect(systemControlsService.getSystemControl).toHaveBeenCalledWith('vitana_did_you_know_enabled');
  });

  it('GET /api/system-controls/:key - returns 404 if control not found', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(null);

    const response = await request(app).get('/api/system-controls/unknown_flag');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'System control not found' });
  });

  it('GET /api/system-controls/:key - passes errors to next middleware', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockRejectedValue(new Error('Service failure'));

    const response = await request(app).get('/api/system-controls/error_flag');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
  });
});