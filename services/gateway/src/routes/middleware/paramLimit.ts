import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const keys = Object.keys(req.params || {});
    
    if (keys.length > maxParams) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Too many path parameters or parameter too long' 
      });
    }
    
    for (const key of keys) {
      const value = req.params[key];
      if (value && value.length > maxLength) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Too many path parameters or parameter too long' 
        });
      }
    }
    
    next();
  };
}