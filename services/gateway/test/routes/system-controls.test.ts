import express from 'express';
import request from 'supertest';
import { systemControlsRouter } from '../../src/routes/system-controls';
import * as systemControlsService from '../../src/services/system-controls';

// Mock the service
jest.mock('../../src/services/system-controls');

// Setup a minimal Express app to test the router
const app = express();
app.use(express.json());
app.use('/api/system-controls', systemControlsRouter);

// Fallback error handler to catch unhandled errors explicitly and prevent Supertest from hanging
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.status(500).json({ error: 'Internal Server Error' });
});

describe('System Controls Route', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return 200 and the control object if the key exists', async () => {
    const mockControl = {
      key: 'vitana_did_you_know_enabled',
      enabled: true,
      updated_at: '2023-01-01T00:00:00Z',
    };

    jest.spyOn(systemControlsService, 'getSystemControl').mockResolvedValue(mockControl);

    const response = await request(app).get('/api/system-controls/vitana_did_you_know_enabled');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockControl);
    expect(systemControlsService.getSystemControl).toHaveBeenCalledWith('vitana_did_you_know_enabled');
  });

  it('should return 404 with an error message if the key does not exist', async () => {
    jest.spyOn(systemControlsService, 'getSystemControl').mockResolvedValue(null);

    const response = await request(app).get('/api/system-controls/missing_key');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'System control not found' });
    expect(systemControlsService.getSystemControl).toHaveBeenCalledWith('missing_key');
  });

  it('should pass errors to the next middleware (returns 500 in this test setup)', async () => {
    jest.spyOn(systemControlsService, 'getSystemControl').mockRejectedValue(new Error('Internal failure'));

    const response = await request(app).get('/api/system-controls/error_key');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal Server Error' });
  });
});