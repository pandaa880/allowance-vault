-- Ledger schema (ADR 0012): double-entry, append-only, integer base units, idempotency keys.
-- Amounts are bigint base units (USDC 6 decimals, INR paise). No personal data in any table.

CREATE TABLE accounts (
  id       text PRIMARY KEY,                       -- "<scope>/<kind>"
  scope    text NOT NULL,                          -- a period or a claim
  kind     text NOT NULL CHECK (kind IN
             ('source', 'authorized', 'reserved', 'released', 'refunded', 'fx_adjustment')),
  currency text NOT NULL CHECK (currency IN ('USDC', 'INR')),
  UNIQUE (scope, kind)
);

CREATE TABLE transactions (
  id         uuid PRIMARY KEY,
  kind       text NOT NULL,
  claim_id   text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE journal_entries (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  txn_id            uuid   NOT NULL REFERENCES transactions (id),
  account_id        text   NOT NULL REFERENCES accounts (id),
  direction         text   NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_base_units bigint NOT NULL CHECK (amount_base_units > 0),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX journal_entries_txn_idx ON journal_entries (txn_id);
CREATE INDEX journal_entries_account_idx ON journal_entries (account_id);

-- The key row is written before its transaction row, so the foreign key is checked at commit.
CREATE TABLE idempotency_keys (
  key          text PRIMARY KEY,
  request_hash text NOT NULL,
  txn_id       uuid NOT NULL REFERENCES transactions (id) DEFERRABLE INITIALLY DEFERRED,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- L2, second line of defence: a transaction must balance when it commits.
CREATE FUNCTION assert_txn_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  debits  numeric;
  credits numeric;
  entries integer;
BEGIN
  SELECT coalesce(sum(amount_base_units) FILTER (WHERE direction = 'debit'), 0),
         coalesce(sum(amount_base_units) FILTER (WHERE direction = 'credit'), 0),
         count(*)
    INTO debits, credits, entries
    FROM journal_entries WHERE txn_id = NEW.txn_id;
  IF entries < 2 OR debits <> credits THEN
    RAISE EXCEPTION 'transaction % does not balance (debits %, credits %, entries %)',
      NEW.txn_id, debits, credits, entries;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_entries_balanced
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_txn_balanced();

-- L2: append-only. Corrections are new entries, never edits.
CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END $$;

CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER transactions_append_only BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER idempotency_keys_append_only BEFORE UPDATE OR DELETE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
