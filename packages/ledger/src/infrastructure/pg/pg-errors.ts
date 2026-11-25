/** A caught value is `unknown`: narrow it, never assume it is an Error. */
export const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

/** The SQLSTATE of a pg error, or undefined when the value is not one. */
export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/** Failures where nothing was committed and a fresh attempt can succeed. */
export const DEADLOCK_DETECTED = '40P01';
export const SERIALIZATION_FAILURE = '40001';
export const LOCK_NOT_AVAILABLE = '55P03';

const RETRYABLE = new Set([DEADLOCK_DETECTED, SERIALIZATION_FAILURE, LOCK_NOT_AVAILABLE]);
export const isRetryable = (code: string | undefined): boolean =>
  code !== undefined && RETRYABLE.has(code);
