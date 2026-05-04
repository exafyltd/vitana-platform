import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { systemControlsRouter } from '../../src/routes/system-controls';
import * as systemControlsService from '../../src/services/system-controls';

jest.mock('../../src/services/system-controls');

const app = express();
app.use(express.json());
app.use('/api/system-controls', systemControlsRouter);

// Fallback error handler to catch next(error) calls
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  res.status(500).json({ error: err.message });
});

describe('System Controls Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/system-controls/:key returns 200 and the control object', async () => {
    const mockControl = { key: 'vitana_did_you_know_enabled', enabled: true };
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(mockControl);

    const response = await request(app).get('/api/system-controls/vitana_did_you_know_enabled');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockControl);
    expect(systemControlsService.getSystemControl).toHaveBeenCalledWith('vitana_did_you_know_enabled');
  });

  it('GET /api/system-controls/:key returns 404 when the key is not found', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(null);

    const response = await request(app).get('/api/system-controls/unknown_key');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'System control not found' });
  });

  it('GET /api/system-controls/:key returns 500 when the service throws an error', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockRejectedValue(new Error('Internal DB failure'));

    const response = await request(app).get('/api/system-controls/some_key');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal DB failure' });
  });
});