import type { Request, Response, NextFunction } from "express";
import fetch from "node-fetch";

const VTID_FORMAT = /^VTID-\d{4}-\d{4,}$/;

export interface VTIDRequest extends Request {
  context?: {
    vtid?: any;
  };
}

export async function requireVTID(
  req: VTIDRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const vtid = (req.headers["x-vtid"] as string) || req.body?.vtid;

    if (!vtid) {
      res.status(400).json({
        error: "VTID required",
        detail: "Provide VTID via X-VTID header or vtid field in body",
      });
      return;
    }

    if (!VTID_FORMAT.test(vtid)) {
      res.status(400).json({
        error: "Invalid VTID format",
        detail: "VTID must match format: VTID-YYYY-NNNN (e.g., VTID-2025-0001)",
        provided: vtid,
      });
      return;
    }

    const ledger = await lookupVTID(vtid);
    
    if (!ledger) {
      res.status(400).json({
        error: "Unknown VTID",
        detail: "VTID not found in ledger",
        vtid,
      });
      return;
    }

    req.context = {
      ...(req.context || {}),
      vtid: ledger,
    };

    console.log(`✅ VTID validated: ${vtid} - ${ledger.task_family}/${ledger.task_type}`);

    next();
  } catch (error: any) {
    console.error("❌ VTID middleware error:", error);
    res.status(500).json({
      error: "Failed to validate VTID",
      detail: error.message,
    });
  }
}

async function lookupVTID(vtid: string): Promise<any | null> {
  const svcKey = process.env.SUPABASE_SERVICE_ROLE;
  const supabaseUrl = process.env.SUPABASE_URL;

  if (!svcKey || !supabaseUrl) {
    throw new Error("Gateway misconfigured: Missing Supabase credentials");
  }

  const resp = await fetch(
    `${supabaseUrl}/rest/v1/VtidLedger?vtid=eq.${vtid}`,
    {
      method: "GET",
      headers: {
        apikey: svcKey,
        Authorization: `Bearer ${svcKey}`,
      },
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Supabase query failed: ${resp.status} - ${text}`);
  }

  const data: any[] = await resp.json();
  return data.length > 0 ? data[0] : null;
}

export async function optionalVTID(
  req: VTIDRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const vtid = (req.headers["x-vtid"] as string) || req.body?.vtid;

    if (vtid && VTID_FORMAT.test(vtid)) {
      const ledger = await lookupVTID(vtid);
      if (ledger) {
        req.context = {
          ...(req.context || {}),
          vtid: ledger,
        };
        console.log(`ℹ️  Optional VTID attached: ${vtid}`);
      }
    }
  } catch (error) {
    console.warn("⚠️  Optional VTID validation failed:", error);
  }

  next();
}
