import { Router } from 'express';
import { GovernanceController } from '../controllers/governance-controller';

const router = Router();
const controller = new GovernanceController();

// All routes prefixed with /api/v1/governance in index.ts mount

// VTID-0407: Governance evaluation endpoint for deploy enforcement
router.post('/evaluate', (req, res) => controller.evaluateDeploy(req, res));

router.get('/categories', (req, res) => controller.getCategories(req, res));
router.get('/rules', (req, res) => controller.getRules(req, res));
router.get('/rules/:ruleCode', (req, res) => controller.getRuleByCode(req, res));
router.get('/proposals', (req, res) => controller.getProposals(req, res));
router.post('/proposals', (req, res) => controller.createProposal(req, res));
router.patch('/proposals/:proposalId/status', (req, res) => controller.updateProposalStatus(req, res));
router.get('/evaluations', (req, res) => controller.getEvaluations(req, res));
router.get('/violations', (req, res) => controller.getViolations(req, res));
router.get('/feed', (req, res) => controller.getFeed(req, res));
router.get('/enforcements', (req, res) => controller.getEnforcements(req, res));
router.get('/logs', (req, res) => controller.getLogs(req, res));

export default router;

