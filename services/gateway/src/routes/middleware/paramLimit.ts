import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Fallback: Check raw path segments as well. If this middleware is applied via
    // router.use(), req.params might not be populated until the specific route is matched.
    // Checking req.path guarantees mitigation before downstream path-to-regexp execution.
    const segments = req.path.split('/');
    for (const segment of segments) {
      if (segment.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Path parameter too long' });
        return;
      }
    }

    // Primary validation: Count req.params keys and check lengths per plan specifications
    let paramCount = 0;
    if (req.params) {
      for (const key of Object.keys(req.params)) {
        const val = req.params[key];
        // Only count populated parameters (ignoring unmatched optionals mapping to undefined)
        if (val !== undefined) {
          paramCount++;
          if (String(val).length > maxLength) {
            res.status(400).json({ ok: false, error: 'Path parameter too long' });
            return;
          }
        }
      }
    }

    if (paramCount > maxParams) {
      res.status(400).json({ ok: false, error: 'Too many path parameters' });
      return;
    }

    next();
  };
}