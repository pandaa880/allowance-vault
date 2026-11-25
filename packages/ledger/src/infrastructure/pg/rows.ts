import { z } from 'zod';
import { ACCOUNT_KINDS, DIRECTIONS } from '../../domain/journal.js';

/**
 * Rows come back from the database as untyped data, so each query's result is parsed against a
 * schema instead of being trusted through a `query<T>()` type argument (which is only a cast).
 * A row that does not match throws at the edge, not later inside the domain.
 */

const idempotencyRow = z.object({ request_hash: z.string(), txn_id: z.string() });
const totalsRow = z.object({
  kind: z.enum(ACCOUNT_KINDS),
  direction: z.enum(DIRECTIONS),
  total: z.string().regex(/^\d+$/),
});
const lockKeyRow = z.object({ key: z.string().regex(/^-?\d+$/) });
const nameRow = z.object({ name: z.string() });

export const parseIdempotencyRows = (rows: unknown) => z.array(idempotencyRow).parse(rows);
export const parseTotalsRows = (rows: unknown) => z.array(totalsRow).parse(rows);
export const parseLockKeyRows = (rows: unknown) => z.array(lockKeyRow).parse(rows);
export const parseNameRows = (rows: unknown) => z.array(nameRow).parse(rows);
