// Runs before any test module is imported, so config/env.ts validation passes and
// no real database or AI service is ever required. dotenv does not override values
// already present in process.env, so these win over any local .env.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/assistiq_test?schema=public';
process.env.JWT_SECRET = 'test-secret-key-that-is-long-enough';
process.env.JWT_EXPIRES_IN = '1h';
process.env.AI_SERVICE_MODE = 'mock';
process.env.CORS_ORIGIN = '*';
process.env.LOG_LEVEL = 'silent';
