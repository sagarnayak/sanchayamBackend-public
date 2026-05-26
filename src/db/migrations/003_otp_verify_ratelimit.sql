-- tracks wrong OTP verify attempts per email
CREATE TABLE otp_verify_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        VARCHAR(255) NOT NULL,
  ip           VARCHAR(64),
  attempted_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ovl_email_time ON otp_verify_log (email, attempted_at DESC);
