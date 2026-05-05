import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const errorResponse = {
      ok: false,
      error: 'Too many path parameters or parameter too long'
    };

    // 1. Direct check on matched route parameters (if middleware is mounted after matching)
    if (req.params) {
      const keys = Object.keys(req.params);
      if (keys.length > maxParams) {
        res.status(400).json(errorResponse);
        return;
      }

      for (const key of keys) {
        const value = req.params[key];
        if (value && value.length > maxLength) {
          res.status(400).json(errorResponse);
          return;
        }
      }
    }

    // 2. Pre-emptive check on the raw URL path to catch malicious deep paths
    // before they hit vulnerable path-to-regexp parsing layers in child routes.
    const segments = req.path.split('/').filter(Boolean);
    
    // We add an allowance (e.g. 10) for static segments like /api/v1/projects/...
    if (segments.length > maxParams + 10) {
      res.status(400).json(errorResponse);
      return;
    }

    for (const segment of segments) {
      if (segment.length > maxLength) {
        res.status(400).json(errorResponse);
        return;
      }
    }

    next();
  };
}