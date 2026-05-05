import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // Secondary validation using RegExp on the raw URI to catch extremely long 
    // segments before route matching if mounted at the top level
    const url = req.url || '';
    const segmentRegex = new RegExp(`/[^/?#]{${maxLength + 1},}`);
    if (segmentRegex.test(url)) {
      res.status(400).json({ 
        ok: false, 
        error: 'Too many path parameters or parameter too long' 
      });
      return;
    }

    const params = req.params || {};
    const keys = Object.keys(params);

    if (keys.length > maxParams) {
      res.status(400).json({ 
        ok: false, 
        error: 'Too many path parameters or parameter too long' 
      });
      return;
    }

    for (const key of keys) {
      const value = params[key];
      if (typeof value === 'string' && value.length > maxLength) {
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