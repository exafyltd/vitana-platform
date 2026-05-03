import request from 'supertest';
import express from 'express';
import systemControlsRouter from '../../src/routes/system-controls';
import * as systemControlsService from '../../src/services/system-controls';

jest.mock('../../src/services/system-controls');

const app = express();
app.use(express.json());
app.use('/api/system-controls', systemControlsRouter);

describe('System Controls Route', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return 200 and the control if found', async () => {
    const mockControl = {
      key: 'vitana_did_you_know_enabled',
      enabled: true,
    };

    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(mockControl);

    const response = await request(app).get('/api/system-controls/vitana_did_you_know_enabled');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockControl);
    expect(systemControlsService.getSystemControl).toHaveBeenCalledWith('vitana_did_you_know_enabled');
  });

  it('should return 404 if control is not found', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(null);

    const response = await request(app).get('/api/system-controls/missing_key');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'System control not found' });
  });

  it('should return 500 on internal error', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockRejectedValue(new Error('DB connection failed'));

    const response = await request(app).get('/api/system-controls/vitana_did_you_know_enabled');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
  });
});