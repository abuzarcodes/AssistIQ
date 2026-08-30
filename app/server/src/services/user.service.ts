import type { User } from '@prisma/client';
import prisma from '../config/database.js';
import { NotFoundError } from '../utils/errors.js';

/**
 * Prisma `select` that returns a user WITHOUT the password hash. Used everywhere a
 * user is returned to the client so the hash can never leak (spec §6/§16).
 */
export const userSafeSelect = {
  id: true,
  name: true,
  email: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type SafeUser = Omit<User, 'passwordHash'>;

/** Strip the password hash from a full user record. */
export const toSafeUser = (user: User): SafeUser => ({
  id: user.id,
  name: user.name,
  email: user.email,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

/** Fetch a user's safe profile by id, or throw 404. */
export const getUserById = async (id: string): Promise<SafeUser> => {
  const user = await prisma.user.findUnique({
    where: { id },
    select: userSafeSelect,
  });

  if (!user) {
    throw new NotFoundError('User not found');
  }

  return user;
};
