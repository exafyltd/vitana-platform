import { Request, Response, NextFunction } from "express";

export interface VTIDRequest extends Request {
  vtid?: string;
}

export const requireVtid = (
  req: VTIDRequest,
  res: Response,
  next: NextFunction
) => {
  const vtid = req.headers["x-vtid"] || req.body.vtid || req.query.vtid;
  if (!vtid) {
    return res.status(400).json({
      ok: false,
      error: "VTID required",
      message: "Please provide VTID in header (X-VTID), body, or query param",
    });
  }
  req.vtid = vtid as string;
  next();
};
