import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  // Uses RegExp only for validation to prevent ReDoS before express routing parses it.
  // This matches any path segment that exceeds maxLength characters.
  const segmentRegex = new RegExp(`[^/]{${maxLength + 1},}`);

  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Raw path validation to prevent ReDoS on excessively long segments
    if (segmentRegex.test(req.path)) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    // 2. Validate parsed parameters (req.params) length and count 
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