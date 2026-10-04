/**
 * Formatting helpers.
 */

/**
 * Render a byte count for a human.
 *
 * Used in error messages that quote a *configured* limit (section 12.11). A hardcoded
 * "10 MB" in an error message contradicts the configuration the moment an operator
 * changes it, so messages interpolate this instead.
 */
export const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(bytes % (1024 * 1024 * 1024) === 0 ? 0 : 1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(bytes % 1024 === 0 ? 0 : 1)} KB`;
  }
  return `${bytes} B`;
};
