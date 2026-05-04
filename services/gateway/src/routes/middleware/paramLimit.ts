import { RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req, res, next) => {
    const keys = Object.keys(req.params || {});
    
    if (keys.length > maxParams) {
      res.status(400).json({ 
        ok: false, 
        error: 'Too many path parameters or parameter too long' 
      });
      return;
    }

    for (const key of keys) {
      const value = req.params[key];
      if (value && typeof value === 'string' && value.length > maxLength) {
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