import { Router, Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import cors from 'cors';

const router = Router();

const allowedOriginRegex = /^https:\/\/vitana-app-[a-z0-9-]+\.web\.app$/;
const corsOptions = {
  origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return cb(null, true);
    const allowList = [
      'http://localhost:5173',
      'http://localhost:3000',
      'https://id-preview--vitana-v1.lovable.app'
    ];
    if (allowList.includes(origin) || allowedOriginRegex.test(origin)) return cb(null, true);
    cb(null, false);
  },
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 200,
  maxAge: 86400
};

router.options('/', cors(corsOptions));

router.get('/', cors(corsOptions), async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_ROLE_KEY as string,
      { db: { schema: 'oasis' } }
    );

    const { data, error } = await supabase
      .from('commandhub_board_v1')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (error) {
      return res.status(500).json({
        error: 'Database query failed',
        details: error.message
      });
    }

    res.json(data ?? []);
  } catch (err) {
    res.status(500).json({
      error: 'Internal server error',
      details: err instanceof Error ? err.message : 'Unknown error'
    });
  }
});

export default router;
