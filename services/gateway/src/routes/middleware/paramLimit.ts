import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
        // 1. Validate req.params if available
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

        // 2. Use RegExp only for validation (raw path check) to prevent ReDoS on unparsed long segments
        // This stops deep path traversal before Express attempts complex route matching
        const rawSegments = req.path.match(/[^\/]+/g) || [];
        if (rawSegments.length > maxParams + 10) { 
            res.status(400).json({ error: 'Too many path parameters or parameter too long' });
            return;
        }

        for (const segment of rawSegments) {
            if (segment.length > maxLength) {
                res.status(400).json({ error: 'Too many path parameters or parameter too long' });
                return;
            }
        }

        next();
    };
}