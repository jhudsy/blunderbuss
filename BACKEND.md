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
     - /get_puzzle. Selects a puzzle using spaced repetition and returns the puzzle's ID and FEN (move details are not exposed to the client).
     - /check_puzzle. Accepts a user's move and returns whether it was correct; the response may include awarded badges or XP deltas.
- User settings
     - /settings. The user can change the number of days that puzzles are taken from lichess for and the type of games (any of "blitz, rapid, classical") as well as the type of errors that will be reviewed (Blunder, Inaccuracy or Mistake) and the maximum number of puzzles to be stored for that user. If more puzzles are imported than this maximum, older puzzles are removed.
  
     Notes:
     - Settings perftypes are now stored as a JSON array (e.g. ["blitz","rapid"]). The settings endpoint accepts a JSON list when POSTing.
     - The app respects the `LOG_LEVEL` or `CHESSPUZZLE_LOG_LEVEL` environment variable to control logging verbosity (e.g. `LOG_LEVEL=DEBUG`).
- Information
     - /user_information. Returns how many XP the user has, the user's badges, how many days streak the user has.
      - /user_information. Returns how many XP the user has, the user's badges, how many days streak (calendar days with correct activity) and the user's puzzle streak (consecutive correct answers) as `streak` and `puzzle_streak` respectively.
     - /leaderboard. Returns the leaderboad (based on XP). Can be paginated

# Authentication
- Authentication takes place using the lichess SSO (see samples below). Games are loaded on login (see below). The UI formerly exposed a progress polling endpoint for monitoring imports; that polling is no longer used by the frontend.
 - Authentication takes place using the lichess SSO (see samples below). Games are loaded on login (see below). Important security note: the import task no longer accepts the user's access token as a Celery task argument; the worker reads the token from the database to avoid serializing secrets into the broker. If you previously used a broker that stored tokens in messages, rotate (revoke) tokens.

# Getting puzzles

Puzzles are selected using spaced repetition. Whenever a user logs into the system (or once a day, whichever is more frequent), the user's games are retrieved from lichess. The PGN will contain entries such as `24. Bxh6?? { (8.10 -> 1.22) Blunder. f6 was best. }` The board position for this puzzle will be the game following move 23. If the user selects f6 then they have answered the puzzle correctly, any other move is incorrect.

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