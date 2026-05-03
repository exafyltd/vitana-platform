import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import systemControlsRouter from '../../src/routes/system-controls';
import { getSystemControl } from '../../src/services/system-controls';

jest.mock('../../src/services/system-controls', () => ({
  getSystemControl: jest.fn()
}));

const app = express();
app.use(express.json());
app.use('/api/system-controls', systemControlsRouter);
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  res.status(500).json({ error: 'Internal server error' });
});

describe('System Controls Routes', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return 200 and the control if found', async () => {
    const mockData = {
      key: 'vitana_did_you_know_enabled',
      enabled: true,
    };
    (getSystemControl as jest.Mock).mockResolvedValue(mockData);

    const response = await request(app).get('/api/system-controls/vitana_did_you_know_enabled');
    
    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockData);
    expect(getSystemControl).toHaveBeenCalledWith('vitana_did_you_know_enabled');
  });

  it('should return 404 if control is not found', async () => {
    (getSystemControl as jest.Mock).mockResolvedValue(null);

    const response = await request(app).get('/api/system-controls/unknown_key');
    
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'System control not found' });
  });

  it('should return 500 if an error occurs', async () => {
    (getSystemControl as jest.Mock).mockRejectedValue(new Error('Service Error'));

    const response = await request(app).get('/api/system-controls/vitana_did_you_know_enabled');
    
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
  });
});