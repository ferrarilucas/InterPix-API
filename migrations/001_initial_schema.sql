CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE subscription_status AS ENUM (
  'PENDING_AUTH', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELED', 'AUTH_DENIED'
);

CREATE TYPE cycle_status AS ENUM (
  'SCHEDULED', 'SENT', 'PAID', 'FAILED', 'RETRYING', 'ABANDONED', 'CANCELED'
);

CREATE TABLE subscriptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_user_id  TEXT NOT NULL,
  plan_code         TEXT NOT NULL,
  amount            NUMERIC(12,2) NOT NULL,
  interval_months   SMALLINT NOT NULL DEFAULT 1,
  status            subscription_status NOT NULL DEFAULT 'PENDING_AUTH',
  inter_rec_id      TEXT UNIQUE,
  inter_solicrec_id TEXT,
  debtor_tax_id     TEXT NOT NULL,
  debtor_name       TEXT NOT NULL,
  next_due_date     DATE,
  authorized_at     TIMESTAMPTZ,
  canceled_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cycles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id),
  seq             INTEGER NOT NULL,
  due_date        DATE NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,
  status          cycle_status NOT NULL DEFAULT 'SCHEDULED',
  inter_txid      TEXT UNIQUE,
  end_to_end_id   TEXT,
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, seq)
);

CREATE TABLE cycle_attempts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id         UUID NOT NULL REFERENCES cycles(id),
  attempt_number   SMALLINT NOT NULL,
  scheduled_for    DATE NOT NULL,
  sent_at          TIMESTAMPTZ,
  outcome          TEXT,
  failure_reason   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, attempt_number)
);

CREATE TABLE events (
  id              BIGSERIAL PRIMARY KEY,
  subscription_id UUID REFERENCES subscriptions(id),
  cycle_id        UUID REFERENCES cycles(id),
  type            TEXT NOT NULL,
  payload         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE inter_webhook_receipts (
  id           BIGSERIAL PRIMARY KEY,
  dedupe_key   TEXT NOT NULL UNIQUE,
  raw_payload  JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id            BIGSERIAL PRIMARY KEY,
  event_id      BIGINT NOT NULL REFERENCES events(id),
  target_url    TEXT NOT NULL,
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING',
  attempts      SMALLINT NOT NULL DEFAULT 0,
  last_error    TEXT,
  next_retry_at TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON cycles (status, due_date);
CREATE INDEX ON subscriptions (status, next_due_date);
CREATE INDEX ON webhook_deliveries (status, next_retry_at);
CREATE INDEX ON events (subscription_id, created_at);
