-- Notification channels and routing
-- Replaces notification_config with a proper channel/routing split.
-- A channel is a named delivery config (who + how).
-- Routing maps event types to channels.
-- This allows new channels and recipient types to be added without code changes.

INSERT INTO _migrations (name) VALUES ('007_notification_channels');

CREATE TABLE notification_channels (
  name           VARCHAR   PRIMARY KEY,
  channel_type   VARCHAR   NOT NULL DEFAULT 'email',   -- email | webhook (future)
  recipient_type VARCHAR   NOT NULL DEFAULT 'master_admin', -- master_admin | specific_email | specific_user
  recipient_ref  VARCHAR,    -- null for master_admin; email address or user UUID otherwise
  is_active      BOOLEAN   NOT NULL DEFAULT true,
  created_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE notification_routing (
  notification_type  VARCHAR   PRIMARY KEY,
  channel_name       VARCHAR   NOT NULL REFERENCES notification_channels(name),
  is_active          BOOLEAN   NOT NULL DEFAULT true,
  created_at         TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Initial channel: all system alerts go to master admin via email
INSERT INTO notification_channels (name, channel_type, recipient_type) VALUES
  ('admin_alerts', 'email', 'master_admin');

-- Migrate existing routing from notification_config
INSERT INTO notification_routing (notification_type, channel_name, is_active)
SELECT notification_type, 'admin_alerts', is_active
FROM notification_config;

DROP TABLE notification_config;

-- These ENUMs were only used by notification_config
DROP TYPE IF EXISTS notification_recipient;
DROP TYPE IF EXISTS notification_channel;
