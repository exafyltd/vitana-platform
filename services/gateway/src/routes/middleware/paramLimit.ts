import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Validate `req.params` explicitly
    // Filter out undefined values that Express might inject for missing optional params
    const keys = Object.keys(req.params || {}).filter(k => req.params[k] !== undefined);
    
    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      const val = req.params[key];
      if (typeof val === 'string' && val.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 2. Validate `req.path` using RegExp to protect downstream routing from ReDoS.
    // This catches oversized parameters and excessive depth before express runs vulnerable 
    // `path-to-regexp` iterations, which is essential if mounted via router.use().
    const path = req.path || '';
    const segments = path.match(/[^/]+/g) || [];
    
    // Add a safe buffer for static segments in the path, limiting total traversal depth.
    if (segments.length > maxParams + 10) { 
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const segment of segments) {
      if (segment.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}