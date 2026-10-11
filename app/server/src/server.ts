import { createServer } from 'node:http';
import app from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import prisma from './config/database.js';
import { attachSocketServer, detachSocketServer } from './realtime/socketServer.js';

const start = async (): Promise<void> => {
  // Verify database connectivity up front so misconfiguration fails fast and loud.
  try {
    await prisma.$connect();
    logger.info('Database connection established');
  } catch (error) {
    logger.error({ err: error }, 'Failed to connect to the database');
    process.exit(1);
  }

  // Socket.IO and the REST API share one HTTP server, and therefore one port and one
  // lifecycle. Attaching the realtime transport to `app.listen`'s implicit server would work,
  // but the server object it returns is only reachable after the fact — creating it here makes
  // the thing being shut down explicit.
  const httpServer = createServer(app);
  const io = attachSocketServer(httpServer);

  httpServer.listen(env.PORT, () => {
    logger.info(`🚀 AssistIQ backend listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = (signal: string): void => {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    // Detach before closing: the registry must stop accepting emissions the moment the
    // transport goes away, or a request still in flight during the drain would emit into a
    // closed server.
    detachSocketServer(io);

    // Closing Socket.IO first is what makes the drain terminate. It disconnects every client
    // — a client holding a long-lived realtime connection would otherwise keep the HTTP
    // server from reaching its idle state, and graceful shutdown would hang until the
    // process is killed rather than shutting down gracefully.
    io.close(() => {
      httpServer.close(() => {
        void prisma.$disconnect().finally(() => {
          logger.info('HTTP server closed and database disconnected');
          process.exit(0);
        });
      });
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
};

void start();
