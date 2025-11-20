import { Router } from 'express';
import { GovernanceController } from '../controllers/governanceController';

const router = Router();
const controller = new GovernanceController();

// All routes prefixed with /api/v1/governance in index.ts mount
router.get('/rules', (req, res) => controller.getRules(req, res));
router.get('/evaluations', (req, res) => controller.getEvaluations(req, res));
router.get('/enforcements', (req, res) => controller.getEnforcements(req, res));
router.get('/violations', (req, res) => controller.getViolations(req, res));
router.get('/logs', (req, res) => controller.getLogs(req, res));

export default router;
