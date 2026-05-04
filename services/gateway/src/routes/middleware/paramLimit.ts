import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate ReDoS vulnerabilities in older versions of path-to-regexp.
 * Limits the number of path parameters and the length of each parameter's value.
 *
 * @param maxParams - Maximum allowed number of path parameters (default: 5)
 * @param maxLength - Maximum allowed length for any single path parameter (default: 200)
 */
export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
        const keys = Object.keys(req.params);

        if (keys.length > maxParams) {
            res.status(400).json({ error: 'Too many path parameters or parameter too long' });
            return;
        }

        for (const key of keys) {
            const value = req.params[key];
            if (value && value.length > maxLength) {
                res.status(400).json({ error: 'Too many path parameters or parameter too long' });
                return;
            }
        }

        next();
    };
}