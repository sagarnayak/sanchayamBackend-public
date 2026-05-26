-- forgot_password_log: one row per attempt, used for rate limit counting
CREATE TABLE forgot_password_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        VARCHAR(255) NOT NULL,
  ip           VARCHAR(64),
  attempted_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fpl_email_time ON forgot_password_log (email, attempted_at DESC);

-- forgot_password_lockouts: one row per locked email
CREATE TABLE forgot_password_lockouts (
  email        VARCHAR(255) PRIMARY KEY,
  locked_until TIMESTAMP NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);
