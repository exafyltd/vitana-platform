import { Request, Response, NextFunction } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200) {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Regex validation on the raw path to prevent long segments 
    // causing ReDoS before Express route matching even processes them.
    const longSegmentRegex = new RegExp(`[^/]{${maxLength + 1},}`);
    if (longSegmentRegex.test(req.path)) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Path parameter too long' 
      });
    }

    // 2. Validate parsed parameters (handles cases where middleware is mounted 
    // directly on a route and params are already extracted).
    const keys = Object.keys(req.params);
    if (keys.length > maxParams) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Too many path parameters' 
      });
    }

    for (const key of keys) {
      const value = req.params[key];
      if (typeof value === 'string' && value.length > maxLength) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Path parameter too long' 
        });
      }
    }

    next();
  };
}