import { PrismaClient } from '@prisma/client';
import { isProduction } from './env.js';

/**
 * Prisma client singleton.
 *
 * A single instance is reused across the process (and across hot reloads in dev via
 * `globalThis`) to avoid exhausting the database connection pool.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isProduction ? ['error'] : ['error', 'warn'],
  });

if (!isProduction) {
  globalForPrisma.prisma = prisma;
}

export default prisma;
