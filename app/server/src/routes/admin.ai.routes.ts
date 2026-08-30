import { Router } from 'express';
import * as adminAiController from '../controllers/admin.ai.controller.js';

const router = Router();

// These endpoints are mounted under /admin/ai in index.ts and protected by the `authenticate` middleware
router.post('/classify', adminAiController.classify);
router.get('/status', adminAiController.getAiStatus);
router.get('/ml-status', adminAiController.getMlStatus);
router.get('/ml-evaluate', adminAiController.evaluateMlModel);
router.post('/rag/search', adminAiController.searchVectors);
router.post('/debug/chat-pipeline', adminAiController.debugChatPipeline);
router.get('/testing/status', adminAiController.getSystemStatus);
router.get('/vector-stats', adminAiController.getVectorStats);

export default router;
