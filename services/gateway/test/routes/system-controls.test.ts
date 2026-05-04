import request from 'supertest';
import express from 'express';
import { systemControlsRouter } from '../../src/routes/system-controls';
import * as systemControlsService from '../../src/services/system-controls';

jest.mock('../../src/services/system-controls');

const app = express();
app.use(express.json());
app.use('/api/system-controls', systemControlsRouter);

describe('GET /api/system-controls/:key', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 200 and the control data if found', async () => {
    const mockControl = { key: 'test_key', enabled: true };
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(mockControl);

    const response = await request(app).get('/api/system-controls/test_key');
    
    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockControl);
    expect(systemControlsService.getSystemControl).toHaveBeenCalledWith('test_key');
  });

  it('should return 404 if control not found', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(null);

    const response = await request(app).get('/api/system-controls/missing_key');
    
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'System control not found' });
  });

  it('should return 500 if an error occurs', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockRejectedValue(new Error('Test error'));

    const response = await request(app).get('/api/system-controls/error_key');
    
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Test error' });
  });
});