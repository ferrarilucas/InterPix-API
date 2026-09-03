CREATE TABLE transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  txid            TEXT UNIQUE NOT NULL,
  internal_id     TEXT NOT NULL,
  tax_id          TEXT,
  status          TEXT NOT NULL,
  callback_url    TEXT,
  amount          TEXT NOT NULL,
  pix_copy_paste  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON transactions (status, created_at);
