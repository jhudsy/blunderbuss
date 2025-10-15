import os
from pony.orm import Database, Required, Optional, Set
from datetime import datetime, timezone

"""PonyORM models and initialization.

Defines User, Puzzle, and Badge entities used by the application. The
init_db helper binds to a local sqlite file for development and will
back up an existing file to allow schema regeneration during prototyping.
"""

db = Database()

# Encryption helper for token fields. If ENCRYPTION_KEY is set in the
# environment we attempt to use Fernet symmetric encryption. If the
# cryptography package is not available or the key is not set, we fall
# back to plaintext storage for development convenience.
ENCRYPTION_FERNET = None
try:
    _enc_key = os.environ.get('ENCRYPTION_KEY')
    if _enc_key:
        try:
            from cryptography.fernet import Fernet
            # Accept both raw key or base64; Fernet expects a urlsafe base64 key
            ENCRYPTION_FERNET = Fernet(_enc_key)
        except Exception:
            # If importing cryptography fails or key invalid, disable encryption
            ENCRYPTION_FERNET = None
    else:
        ENCRYPTION_FERNET = None
except Exception:
    ENCRYPTION_FERNET = None


class User(db.Entity):
    username = Required(str, unique=True)
    # Persist encrypted tokens in *_encrypted fields and expose plain-text
    # via properties so existing code works unchanged.
    access_token_encrypted = Optional(str, nullable=True)
    # Allow refresh_token to be explicitly nullable. Some OAuth providers (including
    # public Lichess clients) may not return a refresh token. Making this field
    # nullable avoids errors when assigning None during token exchange.
    refresh_token_encrypted = Optional(str, nullable=True)
    token_expires_at = Optional(float)
    puzzles = Set('Puzzle')
    xp = Optional(int, default=0)
    # badges stored as related Badge entities
    badges = Set('Badge')
    correct_count = Optional(int, default=0)
    # cooldown in minutes between repeats
    cooldown_minutes = Optional(int, default=10)
    consecutive_correct = Optional(int, default=0)
    # longest puzzle streak recorded for this user
    best_puzzle_streak = Optional(int, default=0)
    settings_days = Optional(int, default=30)
    settings_perftypes = Optional(str, default='["blitz","rapid"]')
    # Which puzzle tags the user wants to see. Stored as a JSON array of
    # strings; defaults to showing all types. Examples: ["Blunder","Mistake"]
    settings_tags = Optional(str, default='["Blunder","Mistake","Inaccuracy"]')
    # Maximum number of puzzles to keep for this user. 0 means unlimited.
    settings_max_puzzles = Optional(int, default=0)
    streak_days = Optional(int, default=0)
    # longest calendar-day streak recorded for this user
    best_streak_days = Optional(int, default=0)
    # record when user first had activity (ISO date string)
    _first_game_date = Optional(str)
    # XP accumulated today (resets on day change) stored as int and the date it refers to
    xp_today = Optional(int, default=0)
    xp_today_date = Optional(str)
    _import_total = Optional(int, default=0)
    _import_done = Optional(int, default=0)
    # Human-readable import status: 'idle', 'in_progress', 'finished'
    _import_status = Optional(str)
    # Optional short error message when import fails
    # Make nullable=True so code can clear the error by assigning None.
    _import_error = Optional(str, nullable=True)
    _last_game_date = Optional(str)
    # record when the user last successfully solved a puzzle (ISO date string)
    # This is distinct from _last_game_date which stores the last imported game's date.
    _last_successful_activity_date = Optional(str)

    # access_token property: transparently encrypts/decrypts when ENCRYPTION_FERNET is configured
    @property
    def access_token(self):
        raw = getattr(self, 'access_token_encrypted', None)
        if raw is None:
            return None
        if ENCRYPTION_FERNET:
            try:
                return ENCRYPTION_FERNET.decrypt(raw.encode()).decode()
            except Exception:
                # fall back to stored value if decryption fails
                return raw
        return raw

    @access_token.setter
    def access_token(self, v):
        if v is None:
            self.access_token_encrypted = None
            return
        if ENCRYPTION_FERNET:
            try:
                self.access_token_encrypted = ENCRYPTION_FERNET.encrypt(v.encode()).decode()
                return
            except Exception:
                pass
        # fallback: store plaintext
        self.access_token_encrypted = v

    # refresh_token property mirrors access_token behavior
    @property
    def refresh_token(self):
        raw = getattr(self, 'refresh_token_encrypted', None)
        if raw is None:
            return None
        if ENCRYPTION_FERNET:
            try:
                return ENCRYPTION_FERNET.decrypt(raw.encode()).decode()
            except Exception:
                return raw
        return raw

    @refresh_token.setter
    def refresh_token(self, v):
        if v is None:
            self.refresh_token_encrypted = None
            return
        if ENCRYPTION_FERNET:
            try:
                self.refresh_token_encrypted = ENCRYPTION_FERNET.encrypt(v.encode()).decode()
                return
            except Exception:
                pass
        self.refresh_token_encrypted = v

    @property
    def perf_types(self):
        """Return settings_perftypes as a Python list.

        The DB stores a JSON-encoded list in `settings_perftypes`. This
        helper returns a normalized list of lowercased perf type strings.
        """
        import json
        raw = getattr(self, 'settings_perftypes', None) or '[]'
        try:
            vals = json.loads(raw)
            if isinstance(vals, list):
                return [str(x).strip().lower() for x in vals if x]
        except Exception:
            # fallback: parse CSV-style
            return [p.strip().lower() for p in str(raw).split(',') if p.strip()]
        return []

    @property
    def tag_filters(self):
        """Return settings_tags as a normalized list of lowercase strings.

        This makes comparisons with Puzzle.tag robust to casing differences.
        """
        import json
        raw = getattr(self, 'settings_tags', None) or '[]'
        try:
            vals = json.loads(raw)
            if isinstance(vals, list):
                return [str(x).strip().lower() for x in vals if x]
        except Exception:
            # fallback: accept CSV-style
            return [p.strip().lower() for p in str(raw).split(',') if p.strip()]
        return []

    @perf_types.setter
    def perf_types(self, v):
        import json
        if v is None:
            self.settings_perftypes = json.dumps([])
        elif isinstance(v, (list, tuple)):
            self.settings_perftypes = json.dumps([str(x).strip().lower() for x in v if x])
        else:
            # accept CSV string
            self.settings_perftypes = json.dumps([p.strip().lower() for p in str(v).split(',') if p.strip()])


class Puzzle(db.Entity):
    user = Required(User)
    game_id = Required(str)
    move_number = Required(int)
    fen = Required(str)
    correct_san = Required(str)
    weight = Required(float, default=1.0)
    # spaced repetition fields
    repetitions = Optional(int, default=0)
    interval = Optional(int, default=0)  # days
    ease_factor = Optional(float, default=2.5)
    # Store review timestamps as timezone-aware datetimes (UTC). Using
    # explicit timezone-aware datetimes allows Postgres to persist them as
    # TIMESTAMP WITH TIME ZONE (timestamptz) and avoids ambiguity when
    # reading across processes and drivers.
    next_review = Optional(datetime, nullable=True)
    last_reviewed = Optional(datetime, nullable=True)
    successes = Optional(int, default=0)
    failures = Optional(int, default=0)
    # eval metadata
    pre_eval = Optional(float)
    post_eval = Optional(float)
    tag = Optional(str)
    # severity records the human/eval classification (e.g. 'Blunder', 'Mistake', 'Inaccuracy')
    severity = Optional(str)
    # SAN context for debugging / UI
    # prev_san and next_san were removed — they were debugging helpers and
    # are intentionally omitted from the schema to reduce stored PGN context.
    # optional PGN header metadata for UI
    white = Optional(str)
    black = Optional(str)
    date = Optional(str)
    time_control = Optional(str)
    # computed classification derived from TimeControl header (e.g. 'Bullet','Blitz','Rapid','Classical')
    time_control_type = Optional(str)



class Badge(db.Entity):
    user = Required(User)
    name = Required(str)
    # Many DB drivers (especially sqlite) store DATETIME without preserving
    # tzinfo and may return naive datetimes when reading from the DB. PonyORM
    # can raise UnrepeatableReadError when an attribute's in-memory value has
    # tzinfo while a later read returns a naive datetime (or vice-versa).
    #
    # We store `awarded_at` as a timezone-aware datetime (UTC). Use a
    # lambda so the default is evaluated at insertion time. When exposing
    # the value via JSON/APIs we convert it to an ISO-8601 string.
    awarded_at = Optional(datetime, default=lambda: datetime.now(timezone.utc))
    # optional persistent metadata so badges can be managed by an admin UI
    icon = Optional(str)
    description = Optional(str)

    def to_dict(self):
        """Return a lightweight serializable dict for JSON APIs."""
        return {
            'id': self.id,
            'name': self.name,
            # Return an ISO-8601 string with timezone info so clients receive
            # a stable textual representation (e.g. 2025-10-15T20:34:46.982007+00:00).
            'awarded_at': (self.awarded_at.isoformat() if self.awarded_at else None),
            'icon': self.icon,
            'description': self.description,
        }


def init_db(path='sqlite:///db.sqlite', create_tables=True):
    # If database already bound, ensure mappings are generated for this process
    # (idempotent). It's possible a previous caller bound the provider but did
    # not generate mappings in this process; ensure we generate mappings so
    # PonyORM queries work correctly in every process.
    if getattr(db, 'provider', None) is not None:
        # If schema/mapping hasn't been generated in this process, generate it
        # now. Respect create_tables flag so table creation only happens when
        # explicitly requested.
        try:
            if getattr(db, 'schema', None) is None:
                db.generate_mapping(create_tables=create_tables)
        except Exception:
            # Propagate exceptions so callers can see binding/mapping failures
            raise
        return db

    # Priority 1: Use DATABASE_URL env var (Postgres URI or other supported PonyORM URL)
    database_url = os.environ.get('DATABASE_URL')
    if database_url:
        # PonyORM expects a provider name and connection params; when given a full
        # URL let PonyORM detect the provider (e.g. 'postgres://...').
        try:
            db.bind(provider='postgres', dsn=database_url)
        except Exception:
            # Fallback: let Pony attempt to bind by passing the URL directly
            try:
                db.bind(database_url)
            except Exception:
                # if binding fails, continue to sqlite fallback below
                database_url = None

    # Priority 2: Support explicit PG env vars if provided (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE)
    if not database_url:
        pg_host = os.environ.get('PGHOST')
        pg_db = os.environ.get('PGDATABASE')
        if pg_host and pg_db:
            pg_port = os.environ.get('PGPORT', '5432')
            pg_user = os.environ.get('PGUSER', os.environ.get('POSTGRES_USER', 'postgres'))
            pg_password = os.environ.get('PGPASSWORD', os.environ.get('POSTGRES_PASSWORD', ''))
            # Construct a DSN accepted by psycopg2/PonyORM
            dsn = f"postgresql://{pg_user}:{pg_password}@{pg_host}:{pg_port}/{pg_db}"
            try:
                db.bind(provider='postgres', dsn=dsn)
            except Exception:
                # continue to sqlite fallback
                pass

    # Priority 3: sqlite fallback (existing behavior)
    if getattr(db, 'provider', None) is None:
        # Determine sqlite path. Use DATABASE_FILE env var if set; otherwise
        # place the sqlite file next to this models.py so web and worker processes
        # resolve the same absolute path even if their CWDs differ.
        repo_root = os.path.dirname(os.path.abspath(__file__))
        requested_path = os.environ.get('DATABASE_FILE') or os.path.join(repo_root, 'db.sqlite')
        # Special-case ':memory:' used by some tests: SQLite ':memory:' creates
        # a distinct in-memory DB per connection which leads to surprising
        # missing rows when the web test client and test code use different
        # connections. To keep tests reliable, map ':memory:' to a single
        # shared file under .run/pytest_db.sqlite inside the repo so all
        # processes/requests during a test run operate on the same DB file.
        if requested_path == ':memory:':
            shared_dir = os.path.join(repo_root, '.run')
            try:
                os.makedirs(shared_dir, exist_ok=True)
            except Exception:
                # ignore errors creating the directory; fallback to repo_root
                shared_dir = repo_root
            requested_path = os.path.join(shared_dir, 'pytest_db.sqlite')

        # Ensure parent directory exists and is writable. If not, fall back to
        # a repo-local sqlite file which should be writable by the container's
        # application user (or at least provide a clearer error).
        sqlite_path = requested_path
        try:
            parent = os.path.dirname(sqlite_path) or '/' 
            if parent and not os.path.exists(parent):
                os.makedirs(parent, exist_ok=True)
            # Test write permission by opening the file for append (will create if missing)
            with open(sqlite_path, 'a'):
                pass
        except Exception:
            fallback = os.path.join(repo_root, 'db.sqlite')
            try:
                # attempt to create fallback file
                parent2 = os.path.dirname(fallback)
                if parent2 and not os.path.exists(parent2):
                    os.makedirs(parent2, exist_ok=True)
                with open(fallback, 'a'):
                    pass
                sqlite_path = fallback
                print(f"WARNING: unable to use configured DATABASE_FILE={requested_path}; falling back to {fallback}")
            except Exception as e:
                # re-raise with a clearer message
                raise RuntimeError(f"Unable to prepare sqlite database file at {requested_path} or fallback {fallback}: {e}")

        # By default do NOT move/backup the existing sqlite file. In some dev
        # workflows the automatic backup behavior broke workers that started and
        # moved the DB, causing the web process to create a different DB. To opt
        # into the original backup behavior set BACKUP_DB_ON_INIT=1 in the env.
        if os.environ.get('BACKUP_DB_ON_INIT') == '1' and sqlite_path and os.path.exists(sqlite_path):
            import shutil, time
            bak = f"db.sqlite.bak.{int(time.time())}"
            shutil.move(sqlite_path, bak)
            # Note: existing SQLite DB is backed up above. If you change model nullability
            # or add/remove fields, you'll need to recreate the DB or run a schema migration.
        db.bind('sqlite', filename=sqlite_path, create_db=True)

    # Generate mapping for this process (creates tables only when requested)
    db.generate_mapping(create_tables=create_tables)
    return db
