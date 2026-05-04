import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Pre-route validation on raw path to prevent ReDoS before express matches deeper routes.
    // We use basic string splitting instead of vulnerable regex evaluation.
    const pathSegments = (req.path || '').split('/').filter(Boolean);
    
    for (const segment of pathSegments) {
      if (segment.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }
    
    // Safety bound for the raw path to prevent catastrophic backtracking on overly deep paths
    if (pathSegments.length > maxParams + 15) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    // 2. Parse req.params and count its keys.
    // Handles scenarios where parameters are already populated (e.g. route-level execution)
    const keys = Object.keys(req.params || {});
    
    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      if (req.params[key] && req.params[key].length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}