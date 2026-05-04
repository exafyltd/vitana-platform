import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate ReDoS vulnerabilities in older versions of `path-to-regexp`.
 * Limits the number of consecutive path parameters and their individual lengths.
 * 
 * @param maxParams Maximum number of path parameters allowed (default 5)
 * @param maxLength Maximum string length of any single path parameter (default 200)
 */
export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (!req.params) {
            return next();
        }

        const keys = Object.keys(req.params);

        if (keys.length > maxParams) {
            res.status(400).json({ error: 'Too many path parameters' });
            return;
        }

        for (const key of keys) {
            const value = req.params[key];
            if (value && typeof value === 'string' && value.length > maxLength) {
                res.status(400).json({ error: 'Path parameter too long' });
                return;
            }
        }

        next();
    };
}