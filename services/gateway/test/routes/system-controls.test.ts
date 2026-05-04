import express from 'express';
import request from 'supertest';
import systemControlsRouter from '../../src/routes/system-controls';
import * as systemControlsService from '../../src/services/system-controls';

// Mock the system-controls service
jest.mock('../../src/services/system-controls');

const app = express();
app.use(express.json());
app.use('/api/system-controls', systemControlsRouter);

// Basic error handler to catch next(err) and return a 500
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.status(500).json({ error: 'Internal Server Error' });
});

describe('SystemControls Routes', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/system-controls/:key returns 200 and data if found', async () => {
    const mockData = {
      key: 'vitana_did_you_know_enabled',
      enabled: true,
      updated_at: '2023-10-01T00:00:00Z',
    };
    
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(mockData);

    const response = await request(app).get('/api/system-controls/vitana_did_you_know_enabled');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockData);
    expect(systemControlsService.getSystemControl).toHaveBeenCalledWith('vitana_did_you_know_enabled');
  });

  it('GET /api/system-controls/:key returns 404 if not found', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(null);

    const response = await request(app).get('/api/system-controls/missing_key');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'System control not found' });
    expect(systemControlsService.getSystemControl).toHaveBeenCalledWith('missing_key');
  });

  it('GET /api/system-controls/:key returns 500 on service error', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockRejectedValue(new Error('DB connection failed'));

    const response = await request(app).get('/api/system-controls/broken_key');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal Server Error' });
  });
});