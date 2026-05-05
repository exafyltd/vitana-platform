import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const keys = Object.keys(req.params || {});
    
    if (keys.length > maxParams) {
      res.status(400).json({ 
        ok: false, 
        error: 'Too many path parameters or parameter too long' 
      });
      return;
    }

    for (const key of keys) {
      if (req.params[key] && req.params[key].length > maxLength) {
        res.status(400).json({ 
          ok: false, 
          error: 'Too many path parameters or parameter too long' 
        });
        return;
      }
    }

    next();
  };
}