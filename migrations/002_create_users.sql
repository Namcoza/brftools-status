-- 002: people invited to the status page, by the Google account email they sign in with.
-- The owner (OWNER_EMAIL) is never stored here. Emails are personal data: this table is
-- included in the nightly pg_dumpall, like the rest of the database.
--
-- Recovery: dropping the table removes every invitation; the owner keeps access. To reverse:
--   DROP TABLE users;
--   DELETE FROM schema_migrations WHERE name = '002_create_users.sql';

CREATE TABLE users (
  email text PRIMARY KEY CHECK (email = lower(email)),
  added_at timestamptz NOT NULL DEFAULT now(),
  first_seen_at timestamptz,
  last_seen_at timestamptz
);
