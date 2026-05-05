import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Validate raw path to protect against ReDoS before route handlers match.
    // Checking segments prevents catastrophic backtracking inside path-to-regexp.
    const rawSegments = req.path.split('/');
    for (const segment of rawSegments) {
      if (segment.length > maxLength) {
        res.status(400).json({ 
          ok: false, 
          error: 'Too many path parameters or parameter too long' 
        });
        return;
      }
    }

    // 2. Validate parsed parameters as requested by the mitigation plan.
    if (req.params) {
      const keys = Object.keys(req.params);
      if (keys.length > maxParams) {
        res.status(400).json({ 
          ok: false, 
          error: 'Too many path parameters or parameter too long' 
        });
        return;
      }

      for (const key of keys) {
        const value = req.params[key];
        if (value && value.length > maxLength) {
          res.status(400).json({ 
            ok: false, 
            error: 'Too many path parameters or parameter too long' 
          });
          return;
        }
      }
    }

    next();
  };
}