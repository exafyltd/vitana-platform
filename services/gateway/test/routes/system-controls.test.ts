import express from 'express';
import request from 'supertest';
import { systemControlsRouter } from '../../src/routes/system-controls';
import { getSystemControl } from '../../src/services/system-controls';

jest.mock('../../src/services/system-controls');

const app = express();
app.use(express.json());
app.use('/api/system-controls', systemControlsRouter);
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.status(500).json({ error: 'Internal Server Error' });
});

describe('GET /api/system-controls/:key', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 200 and the control if found', async () => {
    const mockControl = { key: 'vitana_did_you_know_enabled', enabled: true };
    (getSystemControl as jest.Mock).mockResolvedValue(mockControl);

    const res = await request(app).get('/api/system-controls/vitana_did_you_know_enabled');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockControl);
    expect(getSystemControl).toHaveBeenCalledWith('vitana_did_you_know_enabled');
  });

  it('should return 404 if not found', async () => {
    (getSystemControl as jest.Mock).mockResolvedValue(null);

    const res = await request(app).get('/api/system-controls/non_existent_key');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'System control not found' });
  });

  it('should return 500 if service throws', async () => {
    (getSystemControl as jest.Mock).mockRejectedValue(new Error('Test error'));

    const res = await request(app).get('/api/system-controls/test_key');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal Server Error' });
  });
});