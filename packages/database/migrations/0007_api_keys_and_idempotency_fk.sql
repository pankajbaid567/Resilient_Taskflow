-- Migration: 0007_api_keys_and_idempotency_fk
--
-- API credentials are stored only as HMAC-SHA256 fingerprints. Credential
-- validity also depends on revocation, expiry, and the owning user's active
-- state. Legacy users.api_key/api_key_hash columns remain readable only for a
-- future operator-led migration; the application no longer authenticates
-- against either column.

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name varchar(255) NOT NULL,
  key_hash varchar(64) NOT NULL UNIQUE,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT api_keys_hash_format CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT api_keys_expiry_after_creation
    CHECK (expires_at IS NULL OR expires_at > created_at),
  CONSTRAINT api_keys_revocation_after_creation
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX idx_api_keys_expires_at ON api_keys(expires_at);

COMMENT ON COLUMN users.api_key IS
  'Deprecated: plaintext API keys are ignored by the application';
COMMENT ON COLUMN users.api_key_hash IS
  'Deprecated: use api_keys.key_hash with expiry and revocation state';

ALTER TABLE idempotency_keys
  DROP CONSTRAINT idempotency_keys_job_id_fkey,
  ADD CONSTRAINT idempotency_keys_job_id_fkey
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE;
