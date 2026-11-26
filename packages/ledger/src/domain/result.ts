/**
 * The outcome of an operation whose expected failures are values, not exceptions. The caller
 * must look at `ok` before it can reach `value`, so a refusal cannot be ignored by accident.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
