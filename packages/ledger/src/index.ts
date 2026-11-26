// Composition root: the only place that wires adapters and platform APIs to use cases.
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createLedger, type Ledger } from './application/ledger.js';
import {
  PgLedgerRepository,
  type PgLedgerOptions,
} from './infrastructure/pg/pg-ledger-repository.js';

export {
  createLedger,
  type FundAllowance,
  type Ledger,
  type PostOutcome,
  type PostResult,
  type ReserveClaim,
} from './application/ledger.js';
export type { LedgerRepository, LedgerTx } from './application/ports.js';
export * from './domain/errors.js';
export * from './domain/journal.js';
export * from './domain/result.js';
export { migrate } from './infrastructure/pg/migrate.js';
export {
  createPgPool,
  PgLedgerRepository,
  type PgLedgerOptions,
} from './infrastructure/pg/pg-ledger-repository.js';

export const createPgLedger = (pool: Pick<Pool, 'connect'>, options?: PgLedgerOptions): Ledger =>
  createLedger({ repo: new PgLedgerRepository(pool, options), newId: randomUUID });
