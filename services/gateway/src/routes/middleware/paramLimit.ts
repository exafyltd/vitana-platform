import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Direct req.params validation (executes if mounted directly on a route)
    const params = req.params || {};
    const keys = Object.keys(params);

    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      const value = params[key];
      if (value && value.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 2. Pre-route URL validation to prevent ReDoS before path-to-regexp matches.
    // When used globally via router.use(), req.params is not populated yet.
    // This evaluates the raw path using RegExp limits to bypass the vulnerable matcher completely.
    const pathString = req.path || '';
    
    // Check if any single segment between slashes is excessively long
    const segmentRegex = new RegExp(`/[^/]{${maxLength + 1},}`);
    if (segmentRegex.test(pathString)) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    // Rough check for maximum path depth.
    // A standard path structure should not exceed max parameters + static route segments.
    const segmentCount = (pathString.match(/\//g) || []).length;
    if (segmentCount > maxParams + 10) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    next();
  };
}