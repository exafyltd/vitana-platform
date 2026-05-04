import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Catch extremely long segments in the raw path before Express parses them into params.
    // Uses native RegExp only for validation to avoid the vulnerable path-to-regexp matching.
    const longSegmentRegex = new RegExp(`[^/]{${maxLength + 1},}`);
    if (longSegmentRegex.test(req.path)) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    // Parses req.params and counts its keys
    const params = req.params || {};
    const keys = Object.keys(params);

    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      if (params[key] && params[key].length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}