import { Router } from 'express';
import { getMe } from '../controllers/user.controller.js';

// Authentication is applied at mount time in routes/index.ts.
const router = Router();

router.get('/me', getMe);

export default router;
