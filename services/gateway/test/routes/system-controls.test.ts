import express from 'express';
import request from 'supertest';
import systemControlsRouter from '../../src/routes/system-controls';
import * as systemControlsService from '../../src/services/system-controls';

jest.mock('../../src/services/system-controls');

const app = express();
app.use(express.json());
app.use('/api/system-controls', systemControlsRouter);

// Mock error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.status(500).json({ error: err.message });
});

describe('System Controls Routes', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return 200 and the control if found', async () => {
    const mockControl = { key: 'vitana_did_you_know_enabled', enabled: true };
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(mockControl);

    const res = await request(app).get('/api/system-controls/vitana_did_you_know_enabled');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockControl);
    expect(systemControlsService.getSystemControl).toHaveBeenCalledWith('vitana_did_you_know_enabled');
  });

  it('should return 404 if control not found', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(null);

    const res = await request(app).get('/api/system-controls/missing_key');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'System control not found' });
  });

  it('should pass errors to next middleware', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockRejectedValue(new Error('Internal Server Error'));

    const res = await request(app).get('/api/system-controls/error_key');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal Server Error' });
  });
});