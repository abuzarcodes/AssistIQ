import bcrypt from 'bcryptjs';

/**
 * Password hashing via bcrypt (bcryptjs — pure-JS implementation of the same
 * algorithm, so no native build step). Cost factor 12 is a sensible default.
 */
const SALT_ROUNDS = 12;

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, SALT_ROUNDS);

export const comparePassword = (plain: string, hash: string): Promise<boolean> =>
  bcrypt.compare(plain, hash);
