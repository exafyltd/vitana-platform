import { Router, Request, Response, NextFunction } from 'express';
import { listOasisTasks } from '../lib/oasisTasks';
import { randomUUID } from 'crypto';

const router = Router();

/**
 * GET /tasks
 * Mounted at /api/v1/oasis/tasks
 * 
 * Returns a list of OASIS tasks for the Command Hub.
 */
router.get("/tasks", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const limitQuery = req.query.limit;
        const limit = limitQuery ? Number(limitQuery) : 50;

        // Safe fallback if limit is not a number
        const safeLimit = isNaN(limit) ? 50 : limit;

        const tasks = await listOasisTasks(safeLimit);

        res.json({ data: tasks });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /tasks
 * Mounted at /api/v1/oasis/tasks
 * 
 * Creates a new task in Command Hub with minimal payload.
 * Accepts: { title, vtid, status }
 * Adds safe defaults for required vtid_ledger fields.
 */
router.post("/tasks", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { title, vtid, status } = req.body;

        // Validate required fields
        if (!title || typeof title !== 'string' || title.trim().length === 0) {
            return res.status(400).json({
                ok: false,
                error: 'Title is required'
            });
        }

        if (!vtid || typeof vtid !== 'string' || vtid.trim().length === 0) {
            return res.status(400).json({
                ok: false,
                error: 'VTID is required'
            });
        }

        // Normalize status (UI sends "Scheduled", "In Progress", "Completed")
        let normalizedStatus = 'pending';
        if (status) {
            const statusLower = status.toLowerCase().replace(/\s+/g, '_');
            if (['pending', 'active', 'complete', 'blocked', 'cancelled', 'in_progress'].includes(statusLower)) {
                normalizedStatus = statusLower;
            }
        }

        const svcKey = process.env.SUPABASE_SERVICE_ROLE;
        const supabaseUrl = process.env.SUPABASE_URL;

        if (!svcKey || !supabaseUrl) {
            return res.status(500).json({
                ok: false,
                error: 'Gateway misconfigured'
            });
        }

        // Prepare payload with only confirmed existing columns
        const payload = {
            vtid: vtid.trim(),
            title: title.trim(),
            summary: title.trim(),
            layer: 'DEV',
            module: 'COMHU',
            status: normalizedStatus
        };

        // Insert into vtid_ledger
        const resp = await fetch(`${supabaseUrl}/rest/v1/vtid_ledger`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': svcKey,
                'Authorization': `Bearer ${svcKey}`,
                'Prefer': 'return=representation'
            },
            body: JSON.stringify(payload)
        });

        if (!resp.ok) {
            const errorText = await resp.text();
            console.error(`❌ Failed to create task in vtid_ledger: ${resp.status}`, errorText);
            return res.status(502).json({
                ok: false,
                error: 'Failed to create task',
                detail: errorText
            });
        }

        const data = await resp.json();
        const createdTask = Array.isArray(data) ? data[0] : data;

        console.log(`✅ Task created via Command Hub: ${vtid} - ${title}`);

        return res.status(200).json({
            ok: true,
            data: createdTask
        });
    } catch (err: any) {
        console.error('❌ Error creating task:', err);
        next(err);
    }
});

/**
 * GET /specs/dev-screen-inventory
 * Mounted at /api/v1/oasis/specs/dev-screen-inventory
 * 
 * Returns the Developer Screen Inventory specification from OASIS.
 */
router.get("/specs/dev-screen-inventory", async (req: Request, res: Response, next: NextFunction) => {
    try {
        const supabaseUrl = process.env.SUPABASE_URL;
        const svcKey = process.env.SUPABASE_SERVICE_ROLE;

        if (!supabaseUrl || !svcKey) {
            return res.status(500).json({
                ok: false,
                error: 'Gateway misconfigured'
            });
        }

        // Query oasis_specs table for developer screen inventory
        const resp = await fetch(`${supabaseUrl}/rest/v1/oasis_specs?key=eq.dev_screen_inventory_v1&select=data`, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'apikey': svcKey,
                'Authorization': `Bearer ${svcKey}`
            }
        });

        if (!resp.ok) {
            console.error(`❌ Failed to fetch dev screen inventory: ${resp.status}`);
            return res.status(502).json({
                ok: false,
                error: 'Failed to fetch screen inventory'
            });
        }

        const data: any[] = (await resp.json()) as any[];

        if (!data || data.length === 0) {
            return res.status(404).json({
                ok: false,
                error: 'SPEC_NOT_FOUND'
            });
        }

        const spec = data[0];

        return res.json({
            ok: true,
            data: spec.data
        });
    } catch (err: any) {
        console.error('❌ Error fetching dev screen inventory:', err);
        next(err);
    }
});

export default router;

