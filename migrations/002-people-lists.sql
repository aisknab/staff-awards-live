CREATE TABLE people_lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE people_list_entries (
  list_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL,
  PRIMARY KEY (list_id, sort_order),
  FOREIGN KEY (list_id) REFERENCES people_lists(id) ON DELETE CASCADE,
  UNIQUE (list_id, display_name, subtitle)
) STRICT;

CREATE INDEX idx_people_list_entries ON people_list_entries(list_id, sort_order);
