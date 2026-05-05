import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Pre-match validation on req.path to avoid ReDoS during express route matching
    // Extracts raw path segments to check against the length threshold.
    const segmentRegex = /[^\/]+/g;
    const pathSegments = req.path.match(segmentRegex) || [];
    
    for (const segment of pathSegments) {
      if (segment.length > maxLength) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Too many path parameters or parameter too long' 
        });
      }
    }

    // 2. Post-match validation of parsed route parameters (if already populated)
    const keys = Object.keys(req.params || {});
    if (keys.length > maxParams) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Too many path parameters or parameter too long' 
      });
    }

    for (const key of keys) {
      if (req.params[key] && req.params[key].length > maxLength) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Too many path parameters or parameter too long' 
        });
      }
    }

    next();
  };
}