import prisma from '../config/database.js';
import { AppError, NotFoundError } from '../utils/errors.js';
import { getBotById } from './bot.service.js';
import {
  ACCEPTED_AVATAR_LABEL,
  ACCEPTED_AVATAR_MIME_TYPES,
  MAX_AVATAR_BYTES,
} from '../constants/uploads.js';
import { formatBytes } from '../utils/format.js';

/**
 * Bot avatar storage and serving (BOT_IMPLEMENTATION_PLAN.md §9.5, §10.2).
 *
 * **Bytes in the database, not on disk.** The column is `Bytes` (PostgreSQL `bytea`) on
 * `BotConfiguration`. The alternative — a file on the Node host plus a path column — would
 * put a mutable external resource next to a row that a cascade delete removes, so deleting a
 * bot would leave an orphaned file and restoring a database would leave every avatar
 * dangling. At a 512 KB ceiling the row stays comfortably small, backups stay
 * self-consistent, and there is no second store to keep in sync (`§9.5`).
 *
 * **Three validation layers, and they are not redundant.** Multer's `fileFilter` checks the
 * *claimed* MIME type and bounds the bytes; this module re-checks the actual magic bytes and
 * stores the type it sniffed. A client controls the `Content-Type` of a multipart part, so
 * the claim alone would let any file through as long as it announced itself as a PNG.
 */

/**
 * The subset of a multer file this service needs.
 *
 * `buffer` is a Node `Buffer`, which *is* a `Uint8Array` at runtime — but its type is
 * parameterised over `ArrayBufferLike` while Prisma's `Bytes` column wants
 * `Uint8Array<ArrayBuffer>`, and the two are not mutually assignable. `toBytes` below is the
 * single place that friction is absorbed.
 */
export interface UploadedAvatarLike {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/** A `Buffer` as the `Uint8Array<ArrayBuffer>` Prisma's `Bytes` column accepts. Identity. */
const toBytes = (buffer: Buffer): Uint8Array<ArrayBuffer> =>
  buffer as unknown as Uint8Array<ArrayBuffer>;

/**
 * Identify an image from its leading bytes.
 *
 * Each signature is the format's own magic number, read at the offset the spec puts it:
 *
 *  - PNG — `89 50 4E 47 0D 0A 1A 0A` at offset 0 (the 8-byte signature including the CRLF
 *    and the DOS end-of-file marker, which is what makes it a reliable test).
 *  - JPEG — `FF D8 FF` at offset 0. The third byte distinguishes the variants (`E0` JFIF,
 *    `E1` EXIF, `DB` raw), so a two-byte test would accept a file that merely starts `FF D8`.
 *  - WebP — `RIFF` at offset 0 **and** `WEBP` at offset 8. Both halves are required: `RIFF`
 *    alone is also AVI and WAV, so checking only the first four bytes would admit a video.
 *
 * Returns `null` for anything unrecognised, which is the answer for a text file renamed
 * `.png` and for a format the route does not accept.
 */
export const sniffImageMimeType = (buffer: Buffer): string | null => {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
};

/**
 * Reject an upload whose bytes are not the image it claims to be.
 *
 * The claim is checked against the sniff rather than against the accept list, so a file that
 * is a genuine image but labelled with the wrong type is refused too. That is the same
 * "extension and MIME must agree" rule `knowledgeSource.service.validateFile` applies, and
 * for the same reason: the two facts are only useful together, and a mismatch means one of
 * them is lying about what will be rendered.
 */
const assertRealImage = (file: UploadedAvatarLike): string => {
  const sniffed = sniffImageMimeType(file.buffer);

  if (!sniffed) {
    throw new AppError(`That file is not a valid ${ACCEPTED_AVATAR_LABEL} image.`, 400, true, {
      field: 'avatar',
      reason: 'NOT_AN_IMAGE',
    });
  }

  if (!ACCEPTED_AVATAR_MIME_TYPES.includes(file.mimetype) || sniffed !== file.mimetype) {
    throw new AppError(
      `That file is a ${sniffed} image but was uploaded as ${file.mimetype}.`,
      400,
      true,
      { field: 'avatar', reason: 'MIME_MISMATCH', sniffed }
    );
  }

  // Belt and braces: multer already enforces this, but the check costs nothing and keeps
  // the guarantee here rather than in a middleware someone could reorder away.
  if (file.size > MAX_AVATAR_BYTES) {
    throw new AppError(`Image exceeds the ${formatBytes(MAX_AVATAR_BYTES)} limit.`, 413);
  }

  return sniffed;
};

export interface AvatarState {
  avatarUrl: string;
  avatarUpdatedAt: string;
  avatarVersion: number;
}

/** Read the four avatar columns for a bot, or throw 404 when there is no image. */
const readAvatarRow = async (botId: string) => {
  const row = await prisma.botConfiguration.findUnique({
    where: { botId },
    select: {
      avatarData: true,
      avatarMimeType: true,
      avatarUpdatedAt: true,
      avatarVersion: true,
    },
  });

  // No configuration row at all, or a row whose avatar was cleared or never set. Both mean
  // "this bot has no avatar", which is a plain 404 — not an error state.
  if (!row?.avatarData || !row.avatarMimeType || !row.avatarUpdatedAt) {
    throw new NotFoundError('This bot has no avatar');
  }

  return {
    data: Buffer.from(row.avatarData),
    mimeType: row.avatarMimeType,
    updatedAt: row.avatarUpdatedAt,
    version: row.avatarVersion,
  };
};

/**
 * Store an avatar, replacing any previous one (POST /bots/:botId/avatar).
 *
 * Written as a single `upsert`, which is what makes the replacement atomic: there is no
 * window in which the bot has no avatar because the old bytes were cleared before the new
 * ones were written. A bot that has never been configured gets its row created here, which
 * is the same "the first write creates the row" behaviour `updateBotConfig` relies on.
 */
export const saveAvatar = async (
  botId: string,
  userId: string,
  file: UploadedAvatarLike
): Promise<AvatarState> => {
  await getBotById(botId, userId);

  const mimeType = assertRealImage(file);
  const now = new Date();

  const row = await prisma.botConfiguration.upsert({
    where: { botId },
    create: {
      botId,
      avatarData: toBytes(file.buffer),
      avatarMimeType: mimeType,
      avatarUpdatedAt: now,
      avatarVersion: 1,
    },
    update: {
      avatarData: toBytes(file.buffer),
      avatarMimeType: mimeType,
      avatarUpdatedAt: now,
      // Incremented rather than set, so the version only ever moves forward. It is the
      // cache-busting key in the avatar URL: a browser that cached "v3" must not be served
      // "v3" again just because a later upload happened to compute the same value.
      avatarVersion: { increment: 1 },
    },
    select: { avatarUpdatedAt: true, avatarVersion: true },
  });

  return {
    avatarUrl: `/bots/${botId}/avatar`,
    avatarUpdatedAt: (row.avatarUpdatedAt ?? now).toISOString(),
    avatarVersion: row.avatarVersion,
  };
};

/**
 * Clear a bot's avatar (DELETE /bots/:botId/avatar).
 *
 * The version is still bumped, which is the whole reason this is not a no-op when there was
 * no avatar: a browser holding a cached image must be told the image is gone, and it will
 * only re-request a URL whose cache key changed. Clearing an already-clear avatar is
 * therefore a success, not a 404 — the desired end state is what the caller asked for.
 *
 * All four columns are nulled in one `update`, so the row never sits in a state where the
 * bytes are gone but the MIME type remains (which `readAvatarRow` would treat as absent
 * anyway, but leaving it would be a lie in the database).
 */
export const clearAvatar = async (botId: string, userId: string): Promise<AvatarState> => {
  await getBotById(botId, userId);

  const existing = await prisma.botConfiguration.findUnique({
    where: { botId },
    select: { avatarVersion: true },
  });

  // No row: nothing to clear and nothing to create. Returning the current (zero) version
  // keeps the response shape identical to the case where a row did exist.
  if (!existing) {
    return { avatarUrl: `/bots/${botId}/avatar`, avatarUpdatedAt: new Date().toISOString(), avatarVersion: 0 };
  }

  const row = await prisma.botConfiguration.update({
    where: { botId },
    data: {
      avatarData: null,
      avatarMimeType: null,
      avatarUpdatedAt: null,
      avatarVersion: { increment: 1 },
    },
    select: { avatarVersion: true },
  });

  return {
    avatarUrl: `/bots/${botId}/avatar`,
    avatarUpdatedAt: new Date().toISOString(),
    avatarVersion: row.avatarVersion,
  };
};

/**
 * The avatar's bytes and a cache validator (GET /bots/:botId/avatar).
 *
 * The ETag is derived from the version and the byte length, so it changes on every write
 * *and* cannot collide between two different images that happen to share a version — the
 * version alone would be enough given the increment, but tying it to the content means the
 * validator is still correct if the version ever stopped moving (a restored backup, a
 * hand-edited row).
 *
 * Marked `private` deliberately: this is tenant data reached through an authenticated
 * request. A shared proxy caching it would serve one workspace's bot avatar to another.
 */
export const getAvatar = async (botId: string, userId: string) => {
  await getBotById(botId, userId);

  const avatar = await readAvatarRow(botId);

  return {
    ...avatar,
    etag: `"av${avatar.version}-${avatar.data.length}"`,
  };
};
