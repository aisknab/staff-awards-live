ALTER TABLE events ADD COLUMN vote_duration_seconds INTEGER NOT NULL DEFAULT 45 CHECK (vote_duration_seconds BETWEEN 1 AND 600);
ALTER TABLE rounds ADD COLUMN vote_closes_at TEXT;
