import { Router } from "express";
import { supabase } from "../lib/supabase";
import { z } from "zod";

const router = Router();

const querySchema = z.object({
  limit: z.coerce.number().min(1).max(200).default(50),
  status: z.string().optional(),
  layer: z.string().optional(),
  module: z.string().optional(),
});

router.get("/", async (req, res) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid query parameters" });
    }

    const { limit, status, layer, module } = parsed.data;
    let query = supabase
      .from("vtid_ledger")
      .select("vtid, layer, module, status, title, summary, created_at, updated_at")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (status) {
      const statuses = status.split(",").filter(s => s.length > 0);
      if (statuses.length > 0) query = query.in("status", statuses);
    }
    if (layer) query = query.eq("layer", layer);
    if (module) query = query.eq("module", module);

    const { data, error } = await query;
    if (error) throw error;

    res.status(200).json({
      data: data || [],
      meta: {
        count: data?.length || 0,
        limit,
        has_more: (data?.length || 0) >= limit,
      },
    });
  } catch (err) {
    console.error("Tasks API error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export { router as tasksRouter };
