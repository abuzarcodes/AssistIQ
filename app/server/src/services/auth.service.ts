import prisma from '../config/database.js';
import { hashPassword, comparePassword } from '../utils/password.js';
import { signToken } from '../utils/jwt.js';
import { ConflictError, AuthenticationError } from '../utils/errors.js';
import { userSafeSelect, toSafeUser, type SafeUser } from './user.service.js';
import type { RegisterInput, LoginInput } from '../schemas/auth.schema.js';

export interface AuthResult {
  user: SafeUser;
  token: string;
}

/**
 * Register a new user: reject duplicate email, hash the password, persist, and issue
 * a JWT. The password hash is never returned.
 */
export const register = async (input: RegisterInput): Promise<AuthResult> => {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new ConflictError('An account with this email already exists');
  }

  const passwordHash = await hashPassword(input.password);

  const user = await prisma.user.create({
    data: { name: input.name, email: input.email, passwordHash },
    select: userSafeSelect,
  });

  const token = signToken({ sub: user.id, email: user.email });
  return { user, token };
};

/**
 * Authenticate a user. Uses a single generic error for both "no such email" and
 * "wrong password" so we never reveal whether an email is registered (spec §8).
 */
export const login = async (input: LoginInput): Promise<AuthResult> => {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  if (!user) {
    throw new AuthenticationError('Invalid email or password');
  }

  const passwordMatches = await comparePassword(input.password, user.passwordHash);
  if (!passwordMatches) {
    throw new AuthenticationError('Invalid email or password');
  }

  const token = signToken({ sub: user.id, email: user.email });
  return { user: toSafeUser(user), token };
};

