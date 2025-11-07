import { Router, Request, Response } from 'express';
import { kb-store } from './kb-store';
import { KBBundleDocRequest } from './kb-types';

const router = Router();

router.get('/index', (req: Request, res: Response) => {
  try {
    const filters = {
      family_id: req.query.family_id as string | undefined,
      status: req.query.status as string | undefined,
      tag: req.query.tag as string | undefined
    };

    const index = kb-store.getFilteredIndex(filters);
    res.json(index);
  } catch (error: any) {
    console.error('Error loading KB index:', error);
    res.status(500).json({ error: error.message || 'Failed to load KB index' });
  }
});

router.post('/bundle', (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const docs = body.docs as KBBundleDocRequest[] | undefined;
    const maxTotalWords =
      typeof body.max_total_words === 'number' ? body.max_total_words : undefined;

    if (!Array.isArray(docs) || docs.length === 0) {
      return res.status(400).json({
        error: "Request body must include a non-empty 'docs' array"
      });
    }

    for (const d of docs) {
      if (!d || typeof d.doc_id !== 'string') {
        return res.status(400).json({
          error: "Each doc in 'docs' must include a 'doc_id' string"
        });
      }
    }

    const bundle = kb-store.getBundle(docs, maxTotalWords);
    res.json(bundle);
  } catch (error: any) {
    console.error('Error building KB bundle:', error);

    if (typeof error.message === 'string' && error.message.startsWith('KB document not found')) {
      return res.status(404).json({ error: error.message });
    }

    res.status(500).json({
      error: error.message || 'Failed to build KB bundle'
    });
  }
});

router.get('/:docId', (req: Request, res: Response) => {
  try {
    const { docId } = req.params;
    const doc = kb-store.getDoc(docId);

    if (!doc) {
      return res.status(404).json({ error: 'KB document not found' });
    }

    res.json(doc);
  } catch (error: any) {
    console.error(`Error loading KB doc ${req.params.docId}:`, error);
    res.status(500).json({ error: error.message || 'Failed to load KB document' });
  }
});

router.get('/:docId/sections/:sectionId', (req: Request, res: Response) => {
  try {
    const { docId, sectionId } = req.params;
    const result = kb-store.getSection(docId, sectionId);

    if (!result) {
      return res.status(404).json({
        error: 'KB document or section not found'
      });
    }

    res.json(result);
  } catch (error: any) {
    console.error(
      `Error loading KB section ${req.params.docId}/${req.params.sectionId}:`,
      error
    );
    res.status(500).json({ error: error.message || 'Failed to load KB section' });
  }
});

export default router;
