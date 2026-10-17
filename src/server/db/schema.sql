-- AnswerTab schema. Runs on Postgres and PGlite. Idempotent (IF NOT EXISTS).
-- Amounts are integer cents. *_ms columns are on the room clock.

CREATE TABLE IF NOT EXISTS rooms (
  id                     text PRIMARY KEY,
  creator_token_hash     text NOT NULL,
  title                  text NOT NULL,
  kind                   text NOT NULL CHECK (kind IN ('demo','public')),
  pool                   text NOT NULL CHECK (pool IN ('judge','public')),
  question_price_cents   integer NOT NULL CHECK (question_price_cents > 0),
  metoo_price_cents      integer NOT NULL CHECK (metoo_price_cents > 0),
  ceilings_cents         jsonb NOT NULL DEFAULT '[1000,2000,4000]',
  platform_fee_bps       integer NOT NULL DEFAULT 500 CHECK (platform_fee_bps BETWEEN 0 AND 10000),
  language               text NOT NULL DEFAULT 'en-US',
  status                 text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','live','ended','settling','settled','voided')),
  ai_mode                text NOT NULL DEFAULT 'ai' CHECK (ai_mode IN ('ai','manual')),
  ai_mode_reason         text,
  clock_started_at       timestamptz,
  ended_at               timestamptz,
  approve_deadline       timestamptz,
  contest_window_ends_at timestamptz,
  payout_state           text NOT NULL DEFAULT 'none',
  llm_spent_micros       bigint NOT NULL DEFAULT 0,
  created_ip_hash        text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL DEFAULT (now() + interval '7 days')
);

CREATE TABLE IF NOT EXISTS fans (
  id            text PRIMARY KEY,
  room_id       text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  display_name  text NOT NULL,
  fan_token     text NOT NULL UNIQUE,
  is_bot        boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fans_room ON fans(room_id);

CREATE TABLE IF NOT EXISTS tabs (
  id               text PRIMARY KEY,
  room_id          text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  fan_id           text NOT NULL REFERENCES fans(id) ON DELETE CASCADE,
  ceiling_cents    integer NOT NULL CHECK (ceiling_cents > 0),
  funding          text NOT NULL CHECK (funding IN ('card','paypal','bot_card')),
  order_id         text,
  authorization_id text,
  auth_status      text,
  auth_expires_at  timestamptz,
  state            text NOT NULL DEFAULT 'opening' CHECK (state IN ('opening','held','declined','settling','captured','voided','failed')),
  decline_reason   text,
  capture_id       text,
  capture_status   text,
  captured_cents   integer NOT NULL DEFAULT 0,
  fee_cents        integer,
  net_cents        integer,
  released_cents   integer NOT NULL DEFAULT 0,
  refunded_cents   integer NOT NULL DEFAULT 0,
  receipt_token    text UNIQUE,
  settle_attempt   integer NOT NULL DEFAULT 0,
  settled_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, fan_id)
);
CREATE INDEX IF NOT EXISTS tabs_room ON tabs(room_id);

CREATE TABLE IF NOT EXISTS questions (
  id                text PRIMARY KEY,
  room_id           text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  number            integer NOT NULL,
  asker_fan_id      text NOT NULL REFERENCES fans(id) ON DELETE CASCADE,
  text              text NOT NULL,
  clean_text        text NOT NULL,
  cues              jsonb NOT NULL DEFAULT '[]',
  similar_to        integer,
  state             text NOT NULL DEFAULT 'open' CHECK (state IN ('open','hidden','deflected','verifying','locked','review','approved','unpaid')),
  asked_at_ms       integer NOT NULL,
  verdict           text,
  confidence        real,
  span              jsonb,
  quote             text,
  quote_at_ms       integer,
  answer_start_ms   integer,
  quote_source      text,
  creator_confirmed boolean NOT NULL DEFAULT false,
  verifier          jsonb,
  rating            text CHECK (rating IS NULL OR rating IN ('full','half','none')),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, number)
);
CREATE INDEX IF NOT EXISTS questions_room ON questions(room_id);

CREATE TABLE IF NOT EXISTS backings (
  id            text PRIMARY KEY,
  question_id   text NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  room_id       text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  fan_id        text NOT NULL REFERENCES fans(id) ON DELETE CASCADE,
  tab_id        text NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('ask','metoo')),
  amount_cents  integer NOT NULL CHECK (amount_cents > 0),
  backed_at_ms  integer NOT NULL,
  charge_cents  integer,
  state         text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','released','charged','refunded')),
  refunded_cents integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (question_id, fan_id)
);
CREATE INDEX IF NOT EXISTS backings_tab ON backings(tab_id);
CREATE INDEX IF NOT EXISTS backings_question ON backings(question_id);

CREATE TABLE IF NOT EXISTS segments (
  id          text PRIMARY KEY,
  room_id     text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  text        text NOT NULL,
  words       jsonb NOT NULL,
  t_start_ms  integer NOT NULL,
  t_end_ms    integer NOT NULL,
  source      text NOT NULL CHECK (source IN ('spoken','typed','replay')),
  final       boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, seq)
);

CREATE TABLE IF NOT EXISTS detections (
  id            text PRIMARY KEY,
  room_id       text REFERENCES rooms(id) ON DELETE CASCADE,
  purpose       text NOT NULL,
  model         text NOT NULL,
  input_tokens  integer,
  output_tokens integer,
  cache_read_tokens integer,
  cost_micros   bigint NOT NULL DEFAULT 0,
  latency_ms    integer,
  ok            boolean NOT NULL,
  output        jsonb,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS detections_room ON detections(room_id);

CREATE TABLE IF NOT EXISTS contests (
  id            text PRIMARY KEY,
  room_id       text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  tab_id        text NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  backing_id    text NOT NULL REFERENCES backings(id) ON DELETE CASCADE,
  reason        text NOT NULL,
  state         text NOT NULL DEFAULT 'open' CHECK (state IN ('open','deciding','refunded','pending_creator','upheld','failed')),
  finding       text,
  evidence      text,
  explanation   text,
  refund_id     text,
  refund_cents  integer,
  messages      jsonb NOT NULL DEFAULT '[]',
  progress      jsonb NOT NULL DEFAULT '[]',
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  UNIQUE (backing_id)
);

CREATE TABLE IF NOT EXISTS payouts (
  id               text PRIMARY KEY,
  room_id          text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  attempt          integer NOT NULL,
  sender_batch_id  text NOT NULL UNIQUE,
  payout_batch_id  text,
  receiver         text NOT NULL,
  amount_cents     integer NOT NULL,
  platform_fee_cents integer NOT NULL DEFAULT 0,
  fee_cents        integer,
  batch_status     text,
  item_status      text,
  webhook_seen     boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paypal_calls (
  id                text PRIMARY KEY,
  room_id           text REFERENCES rooms(id) ON DELETE CASCADE,
  tab_id            text,
  op                text NOT NULL,
  method            text NOT NULL,
  endpoint          text NOT NULL,
  request_id        text,
  http_status       integer NOT NULL,
  resource_id       text,
  resource_status   text,
  debug_id          text,
  latency_ms        integer NOT NULL,
  request_redacted  jsonb,
  response_redacted jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paypal_calls_room ON paypal_calls(room_id, created_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  id            text PRIMARY KEY,
  event_type    text NOT NULL,
  resource_id   text,
  verified      boolean NOT NULL,
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  error         text
);

CREATE TABLE IF NOT EXISTS disputes (
  id             text PRIMARY KEY,
  tab_id         text REFERENCES tabs(id) ON DELETE SET NULL,
  room_id        text REFERENCES rooms(id) ON DELETE CASCADE,
  status         text,
  reason         text,
  amount_cents   integer,
  evidence_pack  jsonb,
  raw            jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id          text PRIMARY KEY,
  kind        text NOT NULL,
  room_id     text REFERENCES rooms(id) ON DELETE CASCADE,
  run_at      timestamptz NOT NULL,
  state       text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','done','failed')),
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  payload     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, room_id)
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state, run_at);

CREATE TABLE IF NOT EXISTS llm_budget (
  pool          text NOT NULL,
  day           date NOT NULL,
  spent_micros  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (pool, day)
);

CREATE TABLE IF NOT EXISTS synthetic_runs (
  id          text PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok          boolean,
  room_id     text,
  details     jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS status_checks (
  name        text PRIMARY KEY,
  ok          boolean NOT NULL,
  detail      text NOT NULL,
  checked_at  timestamptz NOT NULL DEFAULT now()
);

-- 2026-10-16 review fixes (additive, idempotent).
-- Snapshot at End: only cards already locked when the creator clicked End are charged by default at settle.
ALTER TABLE questions ADD COLUMN IF NOT EXISTS locked_at_end boolean NOT NULL DEFAULT false;
-- Re-ordering a tab that never got an authorization (new size or payment method) uses the next -a{n} suffix.
ALTER TABLE tabs ADD COLUMN IF NOT EXISTS order_attempt integer NOT NULL DEFAULT 0;

-- 2026-10-16 polish (additive, idempotent).
-- First verified PayPal webhook that confirmed the tab's completed capture / the contest's refund (badges only;
-- nothing waits on them).
ALTER TABLE tabs ADD COLUMN IF NOT EXISTS capture_webhook_at timestamptz;
ALTER TABLE contests ADD COLUMN IF NOT EXISTS refund_webhook_at timestamptz;
CREATE INDEX IF NOT EXISTS webhook_events_resource ON webhook_events(resource_id);
-- The stored quote stops before the end of its last transcript segment (the UI finishes it with an ellipsis).
ALTER TABLE questions ADD COLUMN IF NOT EXISTS quote_truncated boolean NOT NULL DEFAULT false;
