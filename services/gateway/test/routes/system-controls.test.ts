import request from 'supertest';
import express from 'express';
import systemControlsRouter from '../../src/routes/system-controls';
import * as systemControlsService from '../../src/services/system-controls';

// Mock the service layer
jest.mock('../../src/services/system-controls');

const app = express();
app.use(express.json());
app.use('/api/system-controls', systemControlsRouter);

// Fallback error handler to mirror typical gateway setup
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.status(500).json({ error: err.message });
});

describe('System Controls Route', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/system-controls/:key should return 200 and the control if it exists', async () => {
    const mockControl = { key: 'vitana_did_you_know_enabled', enabled: true };
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(mockControl);

    const response = await request(app).get('/api/system-controls/vitana_did_you_know_enabled');
    
    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockControl);
    expect(systemControlsService.getSystemControl).toHaveBeenCalledWith('vitana_did_you_know_enabled');
  });

  it('GET /api/system-controls/:key should return 404 if the control does not exist', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(null);

    const response = await request(app).get('/api/system-controls/missing_key');
    
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'System control not found' });
  });

  it('GET /api/system-controls/:key should pass errors to the error handling middleware', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockRejectedValue(new Error('Database error'));

    const response = await request(app).get('/api/system-controls/error_key');
    
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Database error' });
  });
});