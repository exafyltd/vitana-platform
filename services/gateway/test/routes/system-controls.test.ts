import express from 'express';
import request from 'supertest';
import systemControlsRouter from '../../src/routes/system-controls';
import { getSystemControl } from '../../src/services/system-controls';

jest.mock('../../src/services/system-controls');

const app = express();
app.use(express.json());
app.use('/api/system-controls', systemControlsRouter);

describe('System Controls Routes', () => {
  const mockedGetSystemControl = getSystemControl as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 200 and the control data if found', async () => {
    const mockData = { key: 'vitana_did_you_know_enabled', enabled: true };
    mockedGetSystemControl.mockResolvedValue(mockData);

    const response = await request(app).get('/api/system-controls/vitana_did_you_know_enabled');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockData);
    expect(mockedGetSystemControl).toHaveBeenCalledWith('vitana_did_you_know_enabled');
  });

  it('should return 404 if control not found', async () => {
    mockedGetSystemControl.mockResolvedValue(null);

    const response = await request(app).get('/api/system-controls/non_existent');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'System control not found' });
  });

  it('should return 500 on service error', async () => {
    mockedGetSystemControl.mockRejectedValue(new Error('Internal database error'));

    const response = await request(app).get('/api/system-controls/error_key');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
  });
});