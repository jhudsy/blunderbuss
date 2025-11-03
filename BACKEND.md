The backend of the system is built around the following technologies:
- Flask (version >3.1)
- PonyORM to persist user state around puzzles, spaced repetition, etc (see below).
- The lichess API (used to access user games)
- python-chess (used to parse the PGN obtained from lichess)
- Additional dependencies may need to be installed. E.g., gunicorn

# Routes

The backend exposes the following routes:
- For logging in/authentication
     - /login
     - /login-callback
     - /logout
     - (progress polling endpoint previously existed; UI polling removed)
- For presenting a puzzle
     - /get_puzzle. Selects a puzzle using spaced repetition and returns the puzzle's ID and FEN (move details are not exposed to the client). Clears attempt tracking for the new puzzle.
     - /check_puzzle. Accepts evaluation data from the client and returns whether the move was correct based on win likelihood analysis. The endpoint expects:
       - `initial_cp`: Centipawn evaluation of initial position (from Stockfish, in white's perspective)
       - `move_cp`: Centipawn evaluation of position after move (from Stockfish, in white's perspective)
       
       **Note on CP perspective**: All centipawn values are provided in white's perspective (positive = good for white, negative = good for black), regardless of which side is to move. This ensures consistent evaluation comparison without perspective conversion.
       
       The server calculates win likelihood for both positions using the formula:
       ```
       win_likelihood = 50 + 50 * (2 / (e^(-0.00368 * cp) + 1) - 1)
       ```
       
       A move is considered correct if the win chance does not decrease by more than 1%:
       ```
       correct = (move_win - initial_win) >= -1.0
       ```
       
       The response includes `current_attempt`, `max_attempts`, `attempts_remaining`, `max_attempts_reached`, and evaluation details (`initial_cp`, `move_cp`, `initial_win`, `move_win`, `win_change`) to support the multiple attempts feature and client-side display. XP is automatically reduced by half for each incorrect attempt (attempt 1: full XP, attempt 2: 50%, attempt 3: 25%). The response also includes `target_min_win` when incorrect, showing the minimum acceptable win percentage.
- User settings
     - /settings. The user can change the number of days that puzzles are taken from lichess for and the type of games (any of "blitz, rapid, classical") as well as the type of errors that will be reviewed (Blunder, Inaccuracy or Mistake) and the maximum number of puzzles to be stored for that user. If more puzzles are imported than this maximum, older puzzles are removed.
     - A new boolean setting `use_spaced` controls whether puzzles are selected using the spaced-repetition algorithm or chosen at random. The setting is exposed on the `/settings` page and can be POSTed as JSON (field name `use_spaced`) alongside the other settings. New users default to `use_spaced = true`.
     - A new integer setting `max_attempts` (range 1-3, default 3) controls the maximum number of incorrect attempts allowed per puzzle before the solution is automatically revealed. Each incorrect attempt halves the XP reward for that puzzle.
  
     Notes:
     - Settings perftypes are now stored as a JSON array (e.g. ["blitz","rapid"]). The settings endpoint accepts a JSON list when POSTing.
      - The settings endpoint also accepts `use_spaced` (boolean) in the JSON POST body and will persist it to the user's record.
     - The app respects the `LOG_LEVEL` or `BLUNDERBUSS_LOG_LEVEL` environment variable to control logging verbosity (e.g. `LOG_LEVEL=DEBUG`).
- Information
     - /user_information. Returns how many XP the user has, the user's badges, how many days streak the user has.
      - /user_information. Returns how many XP the user has, the user's badges, how many days streak (calendar days with correct activity) and the user's puzzle streak (consecutive correct answers) as `streak` and `puzzle_streak` respectively.
     - /leaderboard. Returns the leaderboad (based on XP). Can be paginated

# Authentication
- Authentication takes place using the lichess SSO (see samples below). Games are loaded on login (see below). The UI formerly exposed a progress polling endpoint for monitoring imports; that polling is no longer used by the frontend.
 - Authentication takes place using the lichess SSO (see samples below). Games are loaded on login (see below). Important security note: the import task no longer accepts the user's access token as a Celery task argument; the worker reads the token from the database to avoid serializing secrets into the broker. If you previously used a broker that stored tokens in messages, rotate (revoke) tokens.

# Getting puzzles

Puzzles are selected using spaced repetition. Whenever a user logs into the system (or once a day, whichever is more frequent), the user's games are retrieved from lichess. The PGN will contain entries such as `24. Bxh6?? { (8.10 -> 1.22) Blunder. f6 was best. }` The board position for this puzzle will be the game following move 23.

**Move Validation with Stockfish:**

Unlike traditional puzzle systems that require an exact move match, this system uses Stockfish evaluation to determine correctness:

- The client evaluates both the initial position and the position after the user's move using Stockfish.js (depth 15)
- Each centipawn evaluation is converted to a win probability: `50 + 50 * (2 / (e^(-0.00368*cp) + 1) - 1)`
- A move is correct if win likelihood doesn't decrease by more than 1%
- This allows multiple valid moves while still catching blunders and serious mistakes

The original best move from the PGN annotation (e.g., "f6" in the example above) is still stored in the database and used for hints, but any move maintaining the position's win likelihood is accepted.

Puzzles are selected for the user based on spaced repetition. Each puzzle has a selection weight, as the user answers the puzzles correctly this selection weight decreases, while incorrect answers increase it. Puzzles are randomly selected based on this selection weight. The more times the puzzle is answered correctly, the faster the selection weight decreases. **Users should only get puzzles from their own games**.

PGN evaluation selection rules
-----------------------------
- Prioritize blunders where the engine evaluation changes sign (for example, a positive evaluation turning negative, or vice versa). These sign-changing swings typically indicate decisive tactical mistakes and are usually more instructive.
- Ignore blunders that meet all of the following conditions: the position was already deeply unfavorable (abs(pre_eval) > 2.0), the evaluation does NOT change sign, and the magnitude of the evaluation increases (abs(post_eval) > abs(pre_eval)). These cases usually reflect long-term losing positions that became slightly worse and are not good teaching puzzles.

Weighting
---------
- Initial puzzle weight is proportional to the magnitude of the evaluation swing (abs(pre_eval - post_eval)).
- If the evaluation sign changes, the parser gives a stronger boost to the initial weight (e.g. max(5.0, swing * 2.0)). For non-sign-changing swings the parser uses a more modest baseline (e.g. max(1.0, swing)).

These rules are implemented in the PGN parser (`pgn_parser.py`) and are used during game import to decide which annotated engine/mistake comments become puzzles and how they are prioritized.

# Samples

- Sample code snippets for logging into lichess can be found under examples/login.py
- A sample PGN file can be found in examples/samples.pgn. 
- To access the user's games from lichess, use the following URL which will return a PGN file `https://lichess.org/api/games/user/<username>?since=<integer timestamp>&analysed=True&evals=True&literate=True&perfType="<comma seperated string taken from blitz,rapid,classical>"`


## Security and deployment notes

- Cookie hardening: Flask session cookies are configured to be secure, HTTP-only and SameSite=Lax by default in the codebase. In local development you can override these settings if required.
- Token storage: `ENCRYPTION_KEY` env var (Fernet) can be provided to encrypt access and refresh tokens in the DB. If unset the app will continue to store tokens in plaintext for local convenience. For production, set `ENCRYPTION_KEY` from a secure secret manager.
- Celery / Redis: The worker constructs a broker URL from `CELERY_BROKER` or `REDIS_HOST`/`REDIS_PORT`/`REDIS_DB` and supports `REDIS_PASSWORD`/`REDIS_AUTH` for authenticated Redis instances. For production, prefer TLS (rediss://) and strong credentials.

- Health endpoint: a lightweight `/health` endpoint returns 200 and is used for container healthchecks.
- Startup validation: entrypoint runs `scripts/validate_env.sh` in production to ensure required environment variables are provided (CI also runs this check via `.github/workflows/env-check.yml`).

# Other notes
- Configuration for e.g. OAuth should be stored in a .env file
- A run_server.sh script should allow one to easily start the server.

## Additional routes implemented in the server

The following endpoints are implemented in the codebase but are not described
above — include them here for completeness:

- `GET /puzzle` — UI route that renders the puzzle page (`templates/puzzle.html`). The frontend uses this as the entry point for the puzzle UI.
- `POST /puzzle_hint` — Returns a minimal hint for the current puzzle. Request body should include `{ "id": <puzzle_id> }` (optional in tests). Response is `{ "from": "e2" }`. Calling this endpoint also marks the puzzle as having had a hint used in the server-side session so `/check_puzzle` can enforce rules (XP cap and no streak increment).
  
     **Note on evaluation-based system**: With the new Stockfish evaluation system, hints still highlight the from-square of the stored correct move. While the system now accepts any move that maintains win likelihood within 1%, the hint points to the originally identified best move from the puzzle data. This provides guidance while still allowing flexibility in move choice.
     
     Implementation notes:
     - The server centralizes session hint access behind tiny helpers (`_get_hints_map`, `_is_hint_used`, `_mark_hint_used`, `_clear_hint_used`) in `backend.py` to avoid repeated try/except patterns and make the session usage easier to test.
     - SAN normalization used when parsing stored SANs is provided by `_strip_move_number` and `_normalize_san` helpers which handle common PGN artifacts (leading move numbers, trailing annotations, simple punctuation).
- `GET /api/badges` — Returns the current user's badges and a small catalog of badge metadata used to enrich UI display.
- `POST /load_games` — Development-only endpoint that accepts `{ "username": "...", "pgn": "..." }` and imports puzzles from the provided PGN. This endpoint is intentionally restricted to non-production environments.
- `GET /api/puzzle_counts` — Returns counts for available and total puzzles for the current user. Accepts optional `perf` and `tags` query parameters to filter the counts.
- `GET /leaderboard_page` — UI route that renders the leaderboard template (`templates/leaderboard.html`).

These entries reflect the current code in `backend.py` and can be used as a quick reference for developers exploring the server-side implementation.
