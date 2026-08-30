import express, { type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { env } from './config/env.js';
import { logger } from './config/logger.js';
import routes from './routes/index.js';
import { notFoundHandler } from './middleware/notFoundHandler.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();

// --- Security & platform middleware (spec §20) ---
app.use(helmet());
app.use(
  cors(
    env.CORS_ORIGIN === '*'
      ? undefined // reflect all origins (no credentials) — fine for Review 1 defaults
      : { origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()), credentials: true }
  )
);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Structured request logging (spec §21). Redaction is configured on the logger.
app.use(pinoHttp({ logger }));

// --- Health check (spec §23): public, unauthenticated, outside the API version prefix. ---
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ success: true, status: 'healthy', service: 'assistiq-backend' });
});

// --- Versioned API (spec §22) ---
app.use('/api/v1', routes);

// --- 404 + centralized error handling ---
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
