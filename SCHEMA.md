# Database schema (overview)

This project uses PonyORM models defined in `models.py`. Below is a concise, human-readable description of the runtime schema, the entity fields, types, defaults, nullability and relationships. The application binds to a local SQLite file by default via `init_db()` (see notes at the end).

## Conventions
- PonyORM declarative entities are used. Pony will create an implicit primary key `id` for each entity unless otherwise specified.
- Type mappings (approximate SQLite equivalents):
  - str -> TEXT
  - int -> INTEGER
  - float -> REAL
  - datetime -> DATETIME / TEXT (ISO format)
- Required(...) means NOT NULL. Optional(...) means nullable.

## User
Represents an authenticated player / account.

Fields:
- id (implicit primary key)
- username: str, Required, unique — user's display name / identity (unique constraint)
- access_token: str, Optional — OAuth access token (nullable)
- refresh_token: str, Optional, nullable=True — OAuth refresh token (explicitly nullable)
- token_expires_at: float, Optional — POSIX epoch float for token expiry
- puzzles: Set(Puzzle) — one-to-many relationship to `Puzzle` (a user owns many puzzles)
- xp: int, Optional, default=0 — accumulated experience points
- badges: Set(Badge) — one-to-many relationship to `Badge` (awarded badges)
- correct_count: int, Optional, default=0 — total correct answers
- cooldown_minutes: int, Optional, default=10 — cooldown between repeats (minutes)
- consecutive_correct: int, Optional, default=0 — streak counter for consecutive correct answers
- settings_days: int, Optional, default=30 — spaced-repetition window
- settings_perftypes: str, Optional, default='blitz,rapid' — comma-separated performance types
- settings_perftypes: str, Optional, default='["blitz","rapid"]' — JSON-encoded list of performance types (e.g., ["classical","rapid","blitz"]). Previously this field stored a CSV string; the repository now stores a JSON array for clarity and easier consumption by APIs.
 - settings_tags: str, Optional, default='["Blunder","Mistake","Inaccuracy"]' — JSON-encoded list of puzzle tags the user wants to see. Used by the selection logic to filter puzzles by `Puzzle.tag`.
 - awarded_at: datetime, Optional, default=datetime.now(timezone.utc) — award timestamp (timezone-aware)

## Relationships (cardinality)
- User 1 — * Puzzle: a user can have many puzzles; each puzzle references a single user (Required).
- User 1 — * Badge: a user can have many badges; each badge references a single user (Required).

PonyORM will create underlying foreign key columns (e.g., `user_id` on `puzzle` and `badge`).

## init_db() behavior
- The project provides `init_db(path='sqlite:///db.sqlite', create_tables=True)` in `models.py`.
- By default the helper now binds to a deterministic location: the `DATABASE_FILE` environment variable (if set) or `db.sqlite` located next to `models.py`. This avoids worker/web processes creating separate DB files due to differing working directories.
- Automatic backup behavior (moving `db.sqlite` to `db.sqlite.bak.<timestamp>`) is disabled unless `BACKUP_DB_ON_INIT=1` is set in the environment. This prevents worker processes from renaming the DB unexpectedly.
- The helper will then call `generate_mapping(create_tables=True)` if `create_tables` is True.
Note: For production use a proper migration tool (Alembic) or a supported DB backend (Postgres, MySQL). The helper is convenient for local development but not a substitute for migrations in production.

## Practical notes and suggestions
  - The model fields prefixed with an underscore (`_import_total`, `_import_done`, `_last_game_date`) are historical/import-tracking fields. They are nullable integers/strings and currently remain in the schema for compatibility.
  - `_last_successful_activity_date`: added to record when the user last successfully solved a puzzle (ISO date string). This field is used for streak calculations and is distinct from `_last_game_date`, which stores the last imported game's date.
- If you plan to run this in production with a different DB backend (Postgres, MySQL), PonyORM supports those backends; verify data type and indexing strategy and add explicit indexes for performance (e.g., `next_review`, `user_id`, `game_id`).
- For APIs that query scheduled puzzles, add an index on `Puzzle.next_review` to speed SELECTs like "due puzzles for review".

## Example (approximate) SQL DDL (SQLite-like)
The following is an approximate translation of the Pony models to SQL for reference. Pony's generated DDL may differ slightly.

CREATE TABLE user (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expires_at REAL,
  xp INTEGER DEFAULT 0,
  correct_count INTEGER DEFAULT 0,
  cooldown_minutes INTEGER DEFAULT 10,
  consecutive_correct INTEGER DEFAULT 0,
  settings_days INTEGER DEFAULT 30,
  settings_perftypes TEXT DEFAULT '["blitz","rapid"]',
  settings_tags TEXT DEFAULT '["Blunder","Mistake","Inaccuracy"]',
  settings_max_puzzles INTEGER DEFAULT 0,
  streak_days INTEGER DEFAULT 0,
  _import_total INTEGER DEFAULT 0,
  _import_done INTEGER DEFAULT 0,
  _last_game_date TEXT
);

CREATE TABLE puzzle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES user(id),
  game_id TEXT NOT NULL,
  move_number INTEGER NOT NULL,
  fen TEXT NOT NULL,
  correct_san TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  repetitions INTEGER DEFAULT 0,
  interval INTEGER DEFAULT 0,
  ease_factor REAL DEFAULT 2.5,
  next_review DATETIME,
  last_reviewed DATETIME,
  successes INTEGER DEFAULT 0,
  failures INTEGER DEFAULT 0,
  pre_eval REAL,
  post_eval REAL,
  tag TEXT,
  white TEXT,
  black TEXT,
  date TEXT,
  time_control TEXT
  ,severity TEXT
  ,time_control_type TEXT
);

CREATE TABLE badge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES user(id),
  name TEXT NOT NULL,
  awarded_at DATETIME,
  icon TEXT,
  description TEXT
);

