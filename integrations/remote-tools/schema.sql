-- Apply only to the explicitly approved dedicated hackathon Neon database.
CREATE TABLE IF NOT EXISTS neon_event_snapshots (
  id uuid PRIMARY KEY,
  events jsonb NOT NULL CHECK (jsonb_typeof(events) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now()
);
