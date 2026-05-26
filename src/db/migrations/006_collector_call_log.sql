-- Collector call log
-- Tracks every API call made by the background refresh cron so the admin UI
-- can show call history, success rates, and failure trends per collector.

INSERT INTO _migrations (name) VALUES ('006_collector_call_log');

CREATE TABLE collector_call_log (
  id              UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  collector_name  VARCHAR             NOT NULL REFERENCES data_collectors(name),
  data_type       collector_data_type NOT NULL,
  success         BOOLEAN             NOT NULL,
  items_requested INT                 NOT NULL DEFAULT 0,
  items_returned  INT                 NOT NULL DEFAULT 0,
  error_message   VARCHAR,
  called_at       TIMESTAMP           NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_collector_call_log_collector_called
  ON collector_call_log(collector_name, called_at DESC);
