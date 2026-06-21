CREATE TABLE events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('DRAFT','LOBBY','LIVE','FINISHED')),
  active_round_id TEXT,
  participant_limit INTEGER NOT NULL CHECK (participant_limit BETWEEN 2 AND 250),
  join_open INTEGER NOT NULL DEFAULT 0 CHECK (join_open IN (0,1)),
  display_blanked INTEGER NOT NULL DEFAULT 0 CHECK (display_blanked IN (0,1)),
  join_token_version INTEGER NOT NULL DEFAULT 1,
  display_token_version INTEGER NOT NULL DEFAULT 1,
  manual_code_version INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  FOREIGN KEY (active_round_id) REFERENCES rounds(id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE nominees (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  UNIQUE (event_id, display_name, subtitle)
) STRICT;

CREATE TABLE awards (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  UNIQUE (event_id, sort_order)
) STRICT;

CREATE TABLE award_nominees (
  award_id TEXT NOT NULL,
  nominee_id TEXT NOT NULL,
  PRIMARY KEY (award_id, nominee_id),
  FOREIGN KEY (award_id) REFERENCES awards(id) ON DELETE CASCADE,
  FOREIGN KEY (nominee_id) REFERENCES nominees(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE rounds (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  award_id TEXT NOT NULL,
  parent_round_id TEXT,
  round_number INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('PENDING','PREVIEW','OPEN','LOCKED','REVEALED','COMPLETE')),
  version INTEGER NOT NULL DEFAULT 1,
  eligible_participant_count INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT,
  locked_at TEXT,
  revealed_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (award_id) REFERENCES awards(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_round_id) REFERENCES rounds(id) ON DELETE SET NULL,
  UNIQUE (award_id, round_number)
) STRICT;

CREATE TABLE round_nominees (
  round_id TEXT NOT NULL,
  nominee_id TEXT NOT NULL,
  PRIMARY KEY (round_id, nominee_id),
  FOREIGN KEY (round_id) REFERENCES rounds(id) ON DELETE CASCADE,
  FOREIGN KEY (nominee_id) REFERENCES nominees(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  anonymous_label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  joined_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  UNIQUE (event_id, anonymous_label)
) STRICT;

CREATE TABLE votes (
  round_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  nominee_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (round_id, participant_id),
  FOREIGN KEY (round_id) REFERENCES rounds(id) ON DELETE CASCADE,
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  FOREIGN KEY (nominee_id) REFERENCES nominees(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','PARTICIPANT','DISPLAY')),
  event_id TEXT,
  participant_id TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE revealed_results (
  round_id TEXT NOT NULL,
  nominee_id TEXT NOT NULL,
  vote_count INTEGER NOT NULL,
  is_winner INTEGER NOT NULL CHECK (is_winner IN (0,1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (round_id, nominee_id),
  FOREIGN KEY (round_id) REFERENCES rounds(id) ON DELETE CASCADE,
  FOREIGN KEY (nominee_id) REFERENCES nominees(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  event_id TEXT,
  action TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX idx_nominees_event ON nominees(event_id, sort_order);
CREATE INDEX idx_awards_event ON awards(event_id, sort_order);
CREATE INDEX idx_rounds_event ON rounds(event_id, created_at);
CREATE INDEX idx_participants_event ON participants(event_id, status);
CREATE INDEX idx_sessions_token ON sessions(token_hash);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX idx_votes_round ON votes(round_id);
CREATE INDEX idx_audit_event ON audit_log(event_id, created_at);
