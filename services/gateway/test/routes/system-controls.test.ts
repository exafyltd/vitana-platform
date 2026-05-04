import request from 'supertest';
import express from 'express';
import systemControlsRouter from '../../src/routes/system-controls';
import * as systemControlsService from '../../src/services/system-controls';

jest.mock('../../src/services/system-controls');

const app = express();
app.use(express.json());
app.use('/api/system-controls', systemControlsRouter);

describe('System Controls Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/system-controls/:key should return 200 and control data if found', async () => {
    const mockControl = { 
      key: 'test_flag', 
      enabled: true, 
      updated_at: '2023-01-01T00:00:00Z' 
    };
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(mockControl);

    const res = await request(app).get('/api/system-controls/test_flag');
    
    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockControl);
    expect(systemControlsService.getSystemControl).toHaveBeenCalledWith('test_flag');
  });

  it('GET /api/system-controls/:key should return 404 when not found', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(null);

    const res = await request(app).get('/api/system-controls/missing_flag');
    
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'System control not found' });
  });

  it('GET /api/system-controls/:key should return 500 on service error', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockRejectedValue(new Error('Internal exception'));

    const res = await request(app).get('/api/system-controls/error_flag');
    
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});