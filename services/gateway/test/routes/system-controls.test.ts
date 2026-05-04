import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { systemControlsRouter } from '../../src/routes/system-controls';
import * as systemControlsService from '../../src/services/system-controls';

jest.mock('../../src/services/system-controls');

const app = express();
app.use(express.json());
app.use('/api/system-controls', systemControlsRouter);

// Add a generic error handler to prevent supertest from logging errors to console
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  res.status(500).json({ error: err.message });
});

describe('System Controls Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/system-controls/:key', () => {
    it('should return 200 and the control if found', async () => {
      const mockControl = { key: 'test_flag', enabled: true };
      jest.spyOn(systemControlsService, 'getSystemControl').mockResolvedValue(mockControl);

      const res = await request(app).get('/api/system-controls/test_flag');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockControl);
      expect(systemControlsService.getSystemControl).toHaveBeenCalledWith('test_flag');
    });

    it('should return 404 if control not found', async () => {
      jest.spyOn(systemControlsService, 'getSystemControl').mockResolvedValue(null);

      const res = await request(app).get('/api/system-controls/missing_flag');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'System control not found' });
    });

    it('should return 500 on server error', async () => {
      jest.spyOn(systemControlsService, 'getSystemControl').mockRejectedValue(new Error('Internal Server Error'));

      const res = await request(app).get('/api/system-controls/test_flag');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal Server Error' });
    });
  });
});