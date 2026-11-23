// Composition root: the only place that wires adapters to use cases.
import type pg from "pg";
import { createLedger, type Ledger } from "./application/ledger.js";
import { PgLedgerRepository } from "./infrastructure/pg/pg-ledger-repository.js";

export { createLedger, type Ledger } from "./application/ledger.js";
export type { LedgerRepository, LedgerTx } from "./application/ports.js";
export * from "./domain/errors.js";
export * from "./domain/journal.js";
export { migrate } from "./infrastructure/pg/migrate.js";
export { createPgPool, PgLedgerRepository } from "./infrastructure/pg/pg-ledger-repository.js";

export const createPgLedger = (pool: pg.Pool): Ledger => createLedger({ repo: new PgLedgerRepository(pool) });
