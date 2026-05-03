import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { systemControlsRouter } from '../../src/routes/system-controls';
import * as systemControlsService from '../../src/services/system-controls';

// Mock the underlying service
jest.mock('../../src/services/system-controls');

const setupApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/system-controls', systemControlsRouter);
  
  // Generic error handler to catch next(error) calls
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    res.status(500).json({ error: 'Internal Server Error' });
  });
  
  return app;
};

describe('System Controls Route', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return 200 and the control data if found', async () => {
    const mockData = { key: 'test_flag', enabled: true };
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(mockData);

    const app = setupApp();
    const response = await request(app).get('/api/system-controls/test_flag');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockData);
    expect(systemControlsService.getSystemControl).toHaveBeenCalledWith('test_flag');
  });

  it('should return 404 if control not found', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(null);

    const app = setupApp();
    const response = await request(app).get('/api/system-controls/missing_flag');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'System control not found' });
  });

  it('should pass errors to next middleware (resulting in 500)', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockRejectedValue(new Error('Service failure'));

    const app = setupApp();
    const response = await request(app).get('/api/system-controls/error_flag');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal Server Error' });
  });
});