import { z } from 'zod';
import { InvalidRequest } from '../domain/errors.js';
import { ACCOUNT_KINDS, CURRENCIES, DIRECTIONS, type PostingRequest } from '../domain/journal.js';

/**
 * Boundary validation. Callers (a workflow activity, a script, anything that deserialised JSON)
 * are untrusted, so every request is parsed here before it reaches the journal. The patterns
 * mirror the SQL CHECK constraints in 0001_init.sql, which stay as the second line of defence;
 * `test/integration/schema-agreement.test.ts` fails if the two disagree. Parsing also copies the
 * request, so later changes by the caller cannot alter what was validated.
 */

/** No "/" so that an account id "<scope>/<kind>" is unambiguous. */
export const SCOPE_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const TXN_KIND_PATTERN = /^[a-z][a-z_-]{0,39}$/;
/** Hyphenated form only: stricter than Postgres' uuid input, which is safe. */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_KEY_BYTES = 200;

const idempotencyKey = z
  .string()
  .min(1)
  .refine((key) => new TextEncoder().encode(key).length <= MAX_KEY_BYTES, {
    message: `at most ${MAX_KEY_BYTES} bytes`,
  });

const entry = z.object({
  account: z.object({
    scope: z.string().regex(SCOPE_PATTERN),
    kind: z.enum(ACCOUNT_KINDS),
  }),
  direction: z.enum(DIRECTIONS),
  // Range and sign are domain rules (InvalidAmount); here only the runtime type is checked, so a
  // JS number sent by mistake is rejected instead of throwing a TypeError inside a sum.
  amount: z.bigint(),
});

const postingRequest = z.object({
  idempotencyKey,
  kind: z.string().regex(TXN_KIND_PATTERN),
  claimId: z.string().regex(UUID_PATTERN).nullable(),
  currency: z.enum(CURRENCIES),
  entries: z.array(entry),
});

/** Throws `InvalidRequest` (with the zod error as `cause`) when `input` is not a valid request. */
export function parsePostingRequest(input: unknown): PostingRequest {
  const parsed = postingRequest.safeParse(input);
  if (!parsed.success) {
    throw new InvalidRequest(`invalid posting request: ${z.prettifyError(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}
