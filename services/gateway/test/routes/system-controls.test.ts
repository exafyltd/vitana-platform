import request from 'supertest';
import express from 'express';
import systemControlsRouter from '../../src/routes/system-controls';
import * as systemControlsService from '../../src/services/system-controls';

jest.mock('../../src/services/system-controls');

const app = express();
app.use(express.json());
app.use('/api/system-controls', systemControlsRouter);

// Simple error handler matching common express patterns
app.use((err: any, req: any, res: any, next: any) => {
  res.status(500).json({ error: err.message });
});

describe('System Controls Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/system-controls/:key returns 200 and control data', async () => {
    const mockData = { key: 'vitana_did_you_know_enabled', enabled: true };
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(mockData);

    const response = await request(app).get('/api/system-controls/vitana_did_you_know_enabled');
    
    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockData);
    expect(systemControlsService.getSystemControl).toHaveBeenCalledWith('vitana_did_you_know_enabled');
  });

  it('GET /api/system-controls/:key returns 404 if control not found', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(null);

    const response = await request(app).get('/api/system-controls/missing_key');
    
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'System control not found' });
  });

  it('GET /api/system-controls/:key returns 500 on unexpected errors', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockRejectedValue(new Error('Test error'));

    const response = await request(app).get('/api/system-controls/some_key');
    
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Test error' });
  });
});