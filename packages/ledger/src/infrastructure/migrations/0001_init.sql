-- Ledger schema (ADR 0012): double-entry, append-only, integer base units, idempotency keys.
-- Amounts are bigint base units (USDC 6 decimals, INR paise). No personal data in any table.
--
-- Everything lives in the `ledger` schema, and every trigger function pins its own search_path
-- and names its tables with the schema, so a session cannot shadow a table with a temporary one
-- (a temporary table is looked up first unless pg_temp is listed explicitly).
-- Constraint names are explicit so later migrations can refer to them.

CREATE SCHEMA ledger;

-- A scope is a period or a claim. Currency belongs to the scope, so one scope can never mix
-- USDC micro-units with paise, even if a script skips the application's check.
CREATE TABLE ledger.scopes (
  scope    text NOT NULL,
  currency text NOT NULL,
  CONSTRAINT scopes_pkey PRIMARY KEY (scope),
  -- No "/" allowed: an account id is "<scope>/<kind>" and must stay unambiguous.
  CONSTRAINT scopes_scope_ck CHECK (scope ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT scopes_currency_ck CHECK (currency IN ('USDC', 'INR')),
  CONSTRAINT scopes_scope_currency_uq UNIQUE (scope, currency)
);

CREATE TABLE ledger.accounts (
  id       text NOT NULL,                          -- "<scope>/<kind>"
  scope    text NOT NULL,
  kind     text NOT NULL,
  currency text NOT NULL,
  CONSTRAINT accounts_pkey PRIMARY KEY (id),
  CONSTRAINT accounts_scope_kind_uq UNIQUE (scope, kind),
  CONSTRAINT accounts_kind_ck CHECK (kind IN
    ('source', 'authorized', 'reserved', 'released', 'refunded', 'fx_adjustment')),
  CONSTRAINT accounts_id_ck CHECK (id = scope || '/' || kind),
  CONSTRAINT accounts_scope_currency_fk FOREIGN KEY (scope, currency)
    REFERENCES ledger.scopes (scope, currency)
);

CREATE TABLE ledger.transactions (
  id          uuid NOT NULL,
  kind        text NOT NULL,
  claim_id    uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Id of the database transaction that created this row; never repeats, unlike a timestamp.
  created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CONSTRAINT transactions_pkey PRIMARY KEY (id),
  CONSTRAINT transactions_kind_ck CHECK (kind ~ '^[a-z][a-z_-]{0,39}$')
);

CREATE TABLE ledger.journal_entries (
  id                bigint GENERATED ALWAYS AS IDENTITY,
  txn_id            uuid NOT NULL,
  account_id        text NOT NULL,
  direction         text NOT NULL,
  amount_base_units bigint NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_entries_pkey PRIMARY KEY (id),
  CONSTRAINT journal_entries_txn_fk FOREIGN KEY (txn_id) REFERENCES ledger.transactions (id),
  CONSTRAINT journal_entries_account_fk FOREIGN KEY (account_id) REFERENCES ledger.accounts (id),
  CONSTRAINT journal_entries_direction_ck CHECK (direction IN ('debit', 'credit')),
  CONSTRAINT journal_entries_amount_ck CHECK (amount_base_units > 0)
);
CREATE INDEX journal_entries_txn_idx ON ledger.journal_entries (txn_id);
CREATE INDEX journal_entries_account_idx ON ledger.journal_entries (account_id);

-- The key row is written before its transaction row, so the foreign key is checked at commit.
CREATE TABLE ledger.idempotency_keys (
  key          text NOT NULL,
  request_hash text NOT NULL,
  txn_id       uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_keys_pkey PRIMARY KEY (key),
  CONSTRAINT idempotency_keys_key_ck CHECK (octet_length(key) BETWEEN 1 AND 200),
  CONSTRAINT idempotency_keys_hash_ck CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_keys_txn_fk FOREIGN KEY (txn_id)
    REFERENCES ledger.transactions (id) DEFERRABLE INITIALLY DEFERRED
);

-- L2, second line of defence. One transaction needs at least two entries, and debits must equal
-- credits within each currency. Checked once per transaction when the database transaction
-- commits (not once per entry: that would cost quadratic time for large transactions).
CREATE FUNCTION ledger.assert_txn_balanced(txn uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  entry_count integer;
BEGIN
  SELECT count(*) INTO entry_count FROM ledger.journal_entries WHERE txn_id = txn;
  IF entry_count < 2 THEN
    RAISE EXCEPTION 'transaction % does not balance: % entries', txn, entry_count;
  END IF;
  IF EXISTS (
    SELECT 1
      FROM ledger.journal_entries e JOIN ledger.accounts a ON a.id = e.account_id
     WHERE e.txn_id = txn
     GROUP BY a.currency
    HAVING coalesce(sum(e.amount_base_units) FILTER (WHERE e.direction = 'debit'), 0)
        <> coalesce(sum(e.amount_base_units) FILTER (WHERE e.direction = 'credit'), 0)
  ) THEN
    RAISE EXCEPTION 'transaction % does not balance within a currency', txn;
  END IF;
END $$;

CREATE FUNCTION ledger.check_new_txn() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM ledger.assert_txn_balanced(NEW.id);
  RETURN NULL;
END $$;

-- Runs at commit for every new transaction row: no empty or unbalanced transaction can commit.
CREATE CONSTRAINT TRIGGER transactions_have_entries
  AFTER INSERT ON ledger.transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger.check_new_txn();

-- A committed transaction is closed: entries may only be added by the database transaction that
-- created it. That makes the commit-time check above complete, because nothing can add entries
-- to a transaction row it has already checked. A guard against mistakes, not a security
-- boundary: a superuser can still disable triggers (see ADR 0012 addendum).
CREATE FUNCTION ledger.assert_entry_in_open_txn() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ledger.transactions
     WHERE id = NEW.txn_id AND created_xid = pg_current_xact_id()
  ) THEN
    RAISE EXCEPTION 'transaction % is closed: entries can only be added when it is created', NEW.txn_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_entries_open_txn_only
  BEFORE INSERT ON ledger.journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger.assert_entry_in_open_txn();

-- L2: append-only. Corrections are new entries, never edits.
CREATE FUNCTION ledger.reject_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
END $$;

-- Every table is append-only, scopes and accounts included (changing an account's kind would
-- rewrite history, and wiping idempotency_keys would let a retry post twice). TRUNCATE is
-- blocked too. ENABLE ALWAYS keeps each guard firing even under session_replication_role =
-- replica, which otherwise switches ordinary triggers off.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['scopes', 'accounts', 'transactions', 'journal_entries', 'idempotency_keys'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON ledger.%I FOR EACH ROW EXECUTE FUNCTION ledger.reject_mutation()',
      t || '_append_only', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON ledger.%I FOR EACH STATEMENT EXECUTE FUNCTION ledger.reject_mutation()',
      t || '_no_truncate', t);
    EXECUTE format('ALTER TABLE ledger.%I ENABLE ALWAYS TRIGGER %I', t, t || '_append_only');
    EXECUTE format('ALTER TABLE ledger.%I ENABLE ALWAYS TRIGGER %I', t, t || '_no_truncate');
  END LOOP;
END $$;

ALTER TABLE ledger.journal_entries ENABLE ALWAYS TRIGGER journal_entries_open_txn_only;
ALTER TABLE ledger.transactions ENABLE ALWAYS TRIGGER transactions_have_entries;

-- Database-wide, not only this schema: no role may create temporary tables by default. Part of
-- the same defence (the guards are also immune to shadowing by search_path above). Runs as the
-- migrating owner or superuser by design.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END $$;
