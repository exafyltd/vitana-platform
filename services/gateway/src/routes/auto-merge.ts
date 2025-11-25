// DEV-CICDL-0207 – Auto-Merge Routes for Autonomous Safe Merge Layer
import { Router } from 'express';
import { AutoMergeController } from '../controllers/auto-merge-controller';

const router = Router();
const controller = new AutoMergeController();

// All routes prefixed with /api/v1/auto-merge in index.ts mount

// Validation endpoint
router.post('/validate', (req, res) => controller.validatePRForAutoMerge(req, res));

// PR entity management
router.post('/pr', (req, res) => controller.upsertPREntity(req, res));
router.get('/pr/:pr_number', (req, res) => controller.getPREntity(req, res));
router.patch('/pr/:pr_number/status', (req, res) => controller.updatePRStatus(req, res));

// PR events
router.post('/pr/:pr_number/event', (req, res) => controller.addPREvent(req, res));

// Eligibility check
router.get('/pr/:pr_number/eligibility', (req, res) => controller.checkEligibility(req, res));

// List PRs
router.get('/prs', (req, res) => controller.listPRs(req, res));

export default router;
