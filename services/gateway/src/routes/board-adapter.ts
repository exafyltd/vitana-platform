import { Router, Request, Response } from "express";
import fetch from "node-fetch";

const router = Router();

router.get("/", async (req: Request, res: Response) => {
  try {
    const limit = String((req.query?.limit as string) ?? "50");
    const supaUrl = process.env.SUPABASE_URL;
    const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!supaUrl || !supaKey) {
      return res.status(500).json({ error: "Missing Supabase envs" });
    }
    const url = new URL(`${supaUrl}/rest/v1/commandhub_board_v1`);
    url.searchParams.set("select", "vtid,title,status,updated_at");
    url.searchParams.set("order", "updated_at.desc");
    url.searchParams.set("limit", limit);

    const r = await fetch(url.toString(), {
      headers: {
        apikey: supaKey,
        Authorization: `Bearer ${supaKey}`,
        Accept: "application/json",
      },
    });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).send(text);
    res.type("application/json").send(text);
  } catch (e: any) {
    res.status(500).json({ error: "board-adapter proxy failed", detail: String(e?.message || e) });
  }
});

export default router;
