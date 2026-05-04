import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate ReDoS vulnerabilities in express routing (path-to-regexp).
 * Rejects requests that contain an excessive number of path parameters or parameter values that are too long.
 *
 * @param maxParams Maximum allowed number of path parameters (default: 5)
 * @param maxLength Maximum allowed string length of any single path parameter (default: 200)
 */
export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
        const keys = Object.keys(req.params || {});

        if (keys.length > maxParams) {
            res.status(400).json({ error: 'Too many path parameters or parameter too long' });
            return;
        }

        for (const key of keys) {
            const value = req.params[key];
            if (value && typeof value === 'string' && value.length > maxLength) {
                res.status(400).json({ error: 'Too many path parameters or parameter too long' });
                return;
            }
        }

        next();
    };
}