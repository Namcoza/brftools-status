-- 001: release history, one row per app start.
--
-- Recovery: the table holds replaceable history only. To reverse this migration:
--   DROP TABLE releases;
--   DELETE FROM schema_migrations WHERE name = '001_create_releases.sql';

CREATE TABLE releases (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX releases_started_at_idx ON releases (started_at DESC);
