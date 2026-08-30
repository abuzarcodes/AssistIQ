import { pino } from 'pino';
import { env, isProduction, isTest } from './env.js';

/**
 * Application-wide structured logger (pino).
 *
 * - Level is driven by LOG_LEVEL.
 * - In non-production we pretty-print for readability; production emits JSON.
 * - Sensitive fields are redacted so we never log passwords, tokens, or auth headers
 *   (spec §21). Redaction applies to the objects passed to the logger (e.g. by pino-http).
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.passwordHash',
      'res.headers["set-cookie"]',
      'password',
      'passwordHash',
      'token',
    ],
    remove: true,
  },
  // Pretty-print for local dev only. Production emits JSON; tests stay quiet and avoid
  // spinning up the pino-pretty worker thread.
  transport:
    isProduction || isTest
      ? undefined
      : {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
});

export default logger;
