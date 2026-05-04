import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
        // 1. Check Express populated params (effective when mounted on specific routes)
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

        // 2. Fallback validation on raw path segments (critical when mounted globally or via router.use())
        // Uses native string split for safe validation to avoid the vulnerable path-to-regexp matching
        const segments = req.path.split('/').filter(Boolean);
        for (const segment of segments) {
            if (segment.length > maxLength) {
                res.status(400).json({ error: 'Too many path parameters or parameter too long' });
                return;
            }
        }

        next();
    };
}