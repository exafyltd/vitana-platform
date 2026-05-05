import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.params) {
      return next();
    }

    // Express populates missing optional parameters with undefined.
    // We only count actively provided parameters for our limit check.
    const activeKeys = Object.keys(req.params).filter(key => req.params[key] !== undefined);
    
    if (activeKeys.length > maxParams) {
      res.status(400).json({ 
        ok: false, 
        error: 'Too many path parameters or parameter too long' 
      });
      return;
    }

    for (const key of activeKeys) {
      const val = req.params[key];
      if (val && typeof val === 'string' && val.length > maxLength) {
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