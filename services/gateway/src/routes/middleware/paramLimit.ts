import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Check parsed route parameters (populated if middleware is mounted on the route or after matching)
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

    // 2. Fallback heuristics: Validate raw path to protect against ReDoS before route matching.
    // Uses a safe RegExp strictly for validation, avoiding vulnerable path-to-regexp usage.
    const path = req.path || '';
    
    // Ensure no path segment exceeds maxLength
    const segmentRegex = new RegExp(`/[^/]{${maxLength + 1},}`);
    if (segmentRegex.test(path)) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    // Limit overall path depth to prevent deep traversal backtracking attacks
    const maxSlashes = maxParams + 10;
    const slashCount = (path.match(/\//g) || []).length;
    if (slashCount > maxSlashes) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    next();
  };
}