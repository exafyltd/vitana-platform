import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.params) {
      const keys = Object.keys(req.params);
      
      // Limit the total number of path parameters
      if (keys.length > maxParams) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }

      // Limit the length of each individual parameter
      for (const key of keys) {
        const val = req.params[key];
        if (typeof val === 'string' && val.length > maxLength) {
          res.status(400).json({ error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    }
    
    next();
  };
}