-- Module 01: User Management
-- currencies, users, sessions, tokens, invitations, password reset, family connections, audit

CREATE TABLE currencies (
  code        VARCHAR(10)  PRIMARY KEY,
  name        VARCHAR      NOT NULL,
  symbol      VARCHAR(10)  NOT NULL,
  decimals    INT          NOT NULL DEFAULT 2,
  is_crypto   BOOLEAN      NOT NULL DEFAULT false,
  is_active   BOOLEAN      NOT NULL DEFAULT true,
  created_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);

INSERT INTO currencies (code, name, symbol, decimals, is_crypto) VALUES
  ('INR', 'Indian Rupee',      '₹',    2, false),
  ('USD', 'US Dollar',         '$',    2, false),
  ('EUR', 'Euro',              '€',    2, false),
  ('GBP', 'British Pound',     '£',    2, false),
  ('AED', 'UAE Dirham',        'AED',  2, false),
  ('SGD', 'Singapore Dollar',  'S$',   2, false),
  ('CAD', 'Canadian Dollar',   'C$',   2, false),
  ('AUD', 'Australian Dollar', 'A$',   2, false),
  ('HKD', 'Hong Kong Dollar',  'HK$',  2, false),
  ('JPY', 'Japanese Yen',      '¥',    0, false),
  ('CHF', 'Swiss Franc',       'CHF',  2, false),
  ('SAR', 'Saudi Riyal',       'SAR',  2, false),
  ('BTC', 'Bitcoin',           '₿',    8, true),
  ('ETH', 'Ethereum',          'ETH',  18, true),
  ('USDT','Tether',            'USDT', 6, true);

CREATE TABLE users (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_code    VARCHAR(12)  NOT NULL UNIQUE,
  email           VARCHAR      NOT NULL UNIQUE,
  name            VARCHAR      NOT NULL,
  password_hash   VARCHAR      NOT NULL,
  base_currency   VARCHAR(10)  NOT NULL DEFAULT 'INR' REFERENCES currencies(code),
  is_master_admin BOOLEAN      NOT NULL DEFAULT false,
  is_suspended    BOOLEAN      NOT NULL DEFAULT false,
  is_deleted      BOOLEAN      NOT NULL DEFAULT false,
  deleted_at      TIMESTAMP,
  created_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE TABLE sessions (
  id           UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID      NOT NULL REFERENCES users(id),
  token_hash   VARCHAR   NOT NULL UNIQUE,
  expires_at   TIMESTAMP NOT NULL,
  last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

-- tracks refresh tokens that have been rotated (for reuse detection)
CREATE TABLE used_refresh_tokens (
  token_hash VARCHAR   PRIMARY KEY,
  used_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

-- any JWT issued before logged_out_at for this user is invalid
CREATE TABLE force_logout (
  user_id      UUID      PRIMARY KEY REFERENCES users(id),
  logged_out_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE invitations (
  id          UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  VARCHAR   NOT NULL UNIQUE,
  label       VARCHAR,
  email       VARCHAR,
  expires_at  TIMESTAMP NOT NULL,
  used_at     TIMESTAMP,
  created_by  UUID      NOT NULL REFERENCES users(id),
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE password_reset_otps (
  id         UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID      NOT NULL REFERENCES users(id),
  otp_hash   VARCHAR   NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at    TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TYPE connection_status AS ENUM ('pending', 'active', 'disconnected');
CREATE TYPE connection_access AS ENUM ('view', 'edit');

CREATE TABLE family_connections (
  id               UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id     UUID              NOT NULL REFERENCES users(id),
  owner_id         UUID              NOT NULL REFERENCES users(id),
  access_level     connection_access,
  status           connection_status NOT NULL DEFAULT 'pending',
  requested_at     TIMESTAMP         NOT NULL DEFAULT NOW(),
  responded_at     TIMESTAMP,
  disconnected_at  TIMESTAMP,
  disconnected_by  UUID              REFERENCES users(id),
  CONSTRAINT no_self_connection CHECK (requester_id != owner_id)
);

-- prevent duplicate pending requests
CREATE UNIQUE INDEX ON family_connections (requester_id, owner_id) WHERE status = 'pending';

CREATE TABLE audit_log (
  id         UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id   UUID      REFERENCES users(id),
  action     VARCHAR   NOT NULL,
  target_id  UUID,
  ip         VARCHAR,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
