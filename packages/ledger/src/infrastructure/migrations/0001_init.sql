-- Ledger schema (ADR 0012): double-entry, append-only, integer base units, idempotency keys.
-- Amounts are bigint base units (USDC 6 decimals, INR paise). No personal data in any table.

CREATE TABLE accounts (
  id       text PRIMARY KEY,                       -- "<scope>/<kind>"
  scope    text NOT NULL,                          -- a period or a claim
  kind     text NOT NULL CHECK (kind IN
             ('source', 'authorized', 'reserved', 'released', 'refunded', 'fx_adjustment')),
  currency text NOT NULL CHECK (currency IN ('USDC', 'INR')),
  UNIQUE (scope, kind),
  CHECK (id = scope || '/' || kind)
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

-- L2, second line of defence. One transaction needs at least two entries, and debits must equal
-- credits within each currency. Checked when the database transaction commits.
CREATE FUNCTION assert_txn_balanced(txn uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  entry_count integer;
BEGIN
  SELECT count(*) INTO entry_count FROM journal_entries WHERE txn_id = txn;
  IF entry_count < 2 THEN
    RAISE EXCEPTION 'transaction % does not balance: % entries', txn, entry_count;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM journal_entries e JOIN accounts a ON a.id = e.account_id
     WHERE e.txn_id = txn
     GROUP BY a.currency
    HAVING coalesce(sum(e.amount_base_units) FILTER (WHERE e.direction = 'debit'), 0)
        <> coalesce(sum(e.amount_base_units) FILTER (WHERE e.direction = 'credit'), 0)
  ) THEN
    RAISE EXCEPTION 'transaction % does not balance within a currency', txn;
  END IF;
END $$;

CREATE FUNCTION check_entry_txn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_txn_balanced(NEW.txn_id);
  RETURN NULL;
END $$;

CREATE FUNCTION check_new_txn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_txn_balanced(NEW.id);
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_entries_balanced
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_entry_txn();

-- A transaction row with no entries must not commit.
CREATE CONSTRAINT TRIGGER transactions_have_entries
  AFTER INSERT ON transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_new_txn();

-- A committed transaction is closed: entries may only be added by the database transaction that
-- created it (its created_at equals now(), which is fixed per transaction). This stops a later
-- balanced pair from changing a closed journal transaction. A guard against mistakes, not a
-- security boundary: a superuser can bypass any trigger (see ADR 0012 addendum).
CREATE FUNCTION assert_entry_in_open_txn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM transactions WHERE id = NEW.txn_id AND created_at = now()) THEN
    RAISE EXCEPTION 'transaction % is closed: entries can only be added when it is created', NEW.txn_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_entries_open_txn_only
  BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION assert_entry_in_open_txn();

-- L2: append-only. Corrections are new entries, never edits.
CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END $$;

-- Every table is append-only, including accounts (changing an account's kind would rewrite
-- history) and idempotency_keys (wiping it would let a retry post twice). TRUNCATE is blocked too.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts', 'transactions', 'journal_entries', 'idempotency_keys'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_mutation()',
      t || '_append_only', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation()',
      t || '_no_truncate', t);
  END LOOP;
END $$;
