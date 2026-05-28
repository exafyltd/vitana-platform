import { Router } from 'express';
import { GovernanceController } from '../controllers/governance-controller';
import { requireAuth, requireAdminAuth } from '../middleware/auth-supabase-jwt';

const router = Router();
const controller = new GovernanceController();

// All routes prefixed with /api/v1/governance in index.ts mount
// AUTH: All routes require valid JWT. Write operations require exafy_admin.

// VTID-0407: Governance evaluation endpoint for deploy enforcement
router.post('/evaluate', requireAuth, (req, res) => controller.evaluateDeploy(req, res));

// Read-only endpoints: require authentication
router.get('/categories', requireAuth, (req, res) => controller.getCategories(req, res));
router.get('/rules', requireAuth, (req, res) => controller.getRules(req, res));
router.get('/rules/:ruleCode', requireAuth, (req, res) => controller.getRuleByCode(req, res));
router.get('/evaluations', requireAuth, (req, res) => controller.getEvaluations(req, res));
router.get('/violations', requireAuth, (req, res) => controller.getViolations(req, res));
router.get('/feed', requireAuth, (req, res) => controller.getFeed(req, res));
router.get('/enforcements', requireAuth, (req, res) => controller.getEnforcements(req, res));
router.get('/logs', requireAuth, (req, res) => controller.getLogs(req, res));

// Proposals: read requires auth, write requires admin
router.get('/proposals', requireAuth, (req, res) => controller.getProposals(req, res));
router.post('/proposals', requireAdminAuth, (req, res) => controller.createProposal(req, res));
router.patch('/proposals/:proposalId/status', requireAdminAuth, (req, res) => controller.updateProposalStatus(req, res));

// VTID-0408: Governance History endpoint
router.get('/history', requireAuth, (req, res) => controller.getHistory(req, res));

export default router;

