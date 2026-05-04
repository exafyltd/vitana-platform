import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import systemControlsRouter from '../../src/routes/system-controls';
import { getSystemControl } from '../../src/services/system-controls';

jest.mock('../../src/services/system-controls');

describe('System Controls Routes', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/system-controls', systemControlsRouter);

    // Mock error handling middleware for testing
    app.use((err: any, req: Request, res: Response, next: NextFunction) => {
      res.status(500).json({ error: 'Internal server error' });
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return 200 and the control if found', async () => {
    const mockControl = { key: 'vitana_did_you_know_enabled', enabled: true };
    (getSystemControl as jest.Mock).mockResolvedValue(mockControl);

    const response = await request(app).get('/api/system-controls/vitana_did_you_know_enabled');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockControl);
    expect(getSystemControl).toHaveBeenCalledWith('vitana_did_you_know_enabled');
  });

  it('should return 404 if control not found', async () => {
    (getSystemControl as jest.Mock).mockResolvedValue(null);

    const response = await request(app).get('/api/system-controls/missing_key');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'System control not found' });
    expect(getSystemControl).toHaveBeenCalledWith('missing_key');
  });

  it('should return 500 and pass errors to next()', async () => {
    (getSystemControl as jest.Mock).mockRejectedValue(new Error('Service failure'));

    const response = await request(app).get('/api/system-controls/error_key');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
  });
});