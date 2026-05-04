import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  // Uses RegExp only for validation, avoiding the vulnerable path-to-regexp matching
  const lengthRegex = new RegExp(`^.{0,${maxLength}}$`);

  return (req: Request, res: Response, next: NextFunction) => {
    const keys = Object.keys(req.params || {});

    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      const value = req.params[key];
      if (value && !lengthRegex.test(String(value))) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}