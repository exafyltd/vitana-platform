import express from 'express';
import request from 'supertest';
import systemControlsRouter from '../src/routes/system-controls';
import * as systemControlsService from '../src/services/system-controls';

jest.mock('../src/services/system-controls');

const app = express();
app.use(express.json());
app.use('/api/system-controls', systemControlsRouter);

describe('System Controls Routes', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return 200 and the system control if found', async () => {
    const mockControl = { key: 'test_flag', enabled: true };
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(mockControl);

    const response = await request(app).get('/api/system-controls/test_flag');
    
    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockControl);
    expect(systemControlsService.getSystemControl).toHaveBeenCalledWith('test_flag');
  });

  it('should return 404 if the system control is not found', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(null);

    const response = await request(app).get('/api/system-controls/missing_flag');
    
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'System control not found' });
    expect(systemControlsService.getSystemControl).toHaveBeenCalledWith('missing_flag');
  });

  it('should return 500 if the service throws an error', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockRejectedValue(new Error('DB connection failed'));

    const response = await request(app).get('/api/system-controls/error_flag');
    
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
  });
});