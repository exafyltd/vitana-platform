import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.params) {
      let definedCount = 0;
      
      for (const key in req.params) {
        const val = req.params[key];
        if (val !== undefined) {
          definedCount++;
          if (typeof val === 'string' && val.length > maxLength) {
            res.status(400).json({ error: 'Too many path parameters or parameter too long' });
            return;
          }
        }
      }

      if (definedCount > maxParams) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }
    next();
  };
}