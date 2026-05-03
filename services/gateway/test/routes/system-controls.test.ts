import express from 'express';
import request from 'supertest';
import systemControlsRouter from '../../src/routes/system-controls';
import * as systemControlsService from '../../src/services/system-controls';

jest.mock('../../src/services/system-controls');

describe('System Controls Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    
    app = express();
    app.use(express.json());
    app.use('/api/system-controls', systemControlsRouter);
    app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    });
  });

  it('should return 200 and the control if found', async () => {
    const mockControl = { key: 'test_flag', enabled: true };
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(mockControl);

    const response = await request(app).get('/api/system-controls/test_flag');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(mockControl);
    expect(systemControlsService.getSystemControl).toHaveBeenCalledWith('test_flag');
  });

  it('should return 404 if control is not found', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockResolvedValue(null);

    const response = await request(app).get('/api/system-controls/missing_flag');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'System control not found' });
  });

  it('should pass errors to next middleware', async () => {
    (systemControlsService.getSystemControl as jest.Mock).mockRejectedValue(new Error('Internal failure'));

    const response = await request(app).get('/api/system-controls/error_flag');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal failure' });
  });
});