import app from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import prisma from './config/database.js';

const start = async (): Promise<void> => {
  // Verify database connectivity up front so misconfiguration fails fast and loud.
  try {
    await prisma.$connect();
    logger.info('Database connection established');
  } catch (error) {
    logger.error({ err: error }, 'Failed to connect to the database');
    process.exit(1);
  }

  const server = app.listen(env.PORT, () => {
    logger.info(`🚀 AssistIQ backend listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    server.close(() => {
      void prisma.$disconnect().finally(() => {
        logger.info('HTTP server closed and database disconnected');
        process.exit(0);
      });
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
};

void start();
