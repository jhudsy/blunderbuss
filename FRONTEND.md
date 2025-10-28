The frontend of the system is built using html and javascript and utilises bootstrap to make it look better. The following technologies should thus be used:
- The latest version of Bootstrap
- chessboard.js 
- chess.js

The latter two are used to display puzzles and ensure moves made by the user are legal.

# The UI

Each webpage should include a menu allowing the user to
- login
- logout
- go to their settings and see their achievements
 - go to their settings and see their achievements
 - in Settings there is a new checkbox "Use spaced repetition" (default ON for new users). When enabled puzzles are selected using the spaced repetition algorithm; when disabled puzzles are selected at random subject to the same time-control and tag filters.
- see the leaderboard
- solve puzzles

The backend endpoints for this functionality are detailed in BACKEND.md

If a user is not logged in, they should be redirected to the login page.

Since there may be a delay in logging in while the system retrieves games, a modal loading progress dialogue, showing the number of games loaded, should be displayed. Using the date of the last game will allow the dialogue to show how many more days of games there are to download.

The solving puzzle page must display the chessboard for the puzzle. When the user makes a move, the system uses the Stockfish chess engine to evaluate both the initial position and the position after the move. 

**Evaluation-based Move Validation:**

The system evaluates moves based on win likelihood rather than comparing against a predetermined correct move. This approach:

1. **Evaluates both positions**: When a user makes a move, Stockfish (running client-side via Web Worker) evaluates:
   - The initial FEN position (before the move)
   - The resulting FEN position (after the move)

2. **Calculates win likelihood**: Each centipawn evaluation is converted to a win probability using the formula:
   ```
   win_likelihood = 50 + 50 * (2 / (e^(-0.00368 * cp) + 1) - 1)
   ```
   Where `cp` is the centipawn evaluation from Stockfish.

3. **Determines correctness**: A move is considered correct if the win chance does not decrease by more than 10%. This allows for multiple valid moves that maintain a good position, rather than requiring one specific move.

4. **Visual feedback**: 
   - During evaluation (2-3 seconds), displays "Analyzing position..." status
   - Correct moves: square turns green, shows win percentage change (e.g., "Correct! Win chance: 65% → 70% (+5%)")
   - Incorrect moves: square turns red, shows win percentage drop (e.g., "Incorrect. Win chance dropped to 40% (-25%)")
   - After a short delay, if incorrect and attempts remain, the board resets
   - If max attempts reached, the correct move is revealed (animated in green)

**Technical Implementation:**

- Stockfish.js (931KB) is loaded from `/static/js/stockfish.js`
- Engine runs in a Web Worker (background thread) to avoid blocking the UI
- Evaluations use depth 15 (balance between speed and accuracy)
- Win likelihood formula matches the one used server-side for consistency
- Client calculates evaluations and sends centipawn values to server for validation

The user receives feedback showing their XP earned, any badges/achievements, and evaluation details. After answering (correct or after max attempts), a link to the game on lichess is provided.

The puzzle page should also show the game's details, i.e., who was white and black, the date the game was played, and the time control (rapid, blitz or classical). 

The user should also get feedback showing how much XP they have earned for getting the puzzle correct, together with any badges or achievements they have earned. Badges/achievements earned will not happen that often and should be displayed via a modal window. XP earned depends on puzzle cooldown; puzzles which appear less frequently (i.e., which have a low selection weight) will have a higher associated XP.

The UI should be attractive and utilise Bootstrap.

## Multiple attempts feature

The application supports configurable maximum incorrect attempts per puzzle. Users
can set this in Settings via a slider (range 1-3, default 3). Key behaviors:

- **Attempt tracking**: The backend tracks incorrect attempts per puzzle using session
  storage. The count resets when a new puzzle is loaded or when the puzzle is solved.

- **XP penalty**: For each incorrect attempt, the XP reward is halved:
  - Attempt 1: Full XP
  - Attempt 2: 50% XP (halved once)
  - Attempt 3: 25% XP (halved twice)

- **Max attempts reached**: When the user exhausts all attempts:
  - The correct solution is revealed automatically
  - Further moves are disabled
  - The "Next" button is enabled to proceed to the next puzzle
  - A message indicates maximum attempts were reached

- **Before max attempts**: If attempts remain after an incorrect move:
  - The board resets to the starting position
  - A message shows how many attempts remain
  - The user can try again immediately
  - Moves remain enabled

- **Settings UI**: A range slider (1-3) in Settings allows users to configure their
  maximum attempts preference. The current value is displayed next to the slider.

## Hint functionality

The puzzle UI includes a "Hint" button that helps users by highlighting the source
square (the square containing the piece that should move) for the correct solution.
Key behaviour and implementation details:

- Visuals
	- Hints are highlighted using a blue overlay on the board square (CSS class
		`.square-highlight-blue`). Incorrect moves continue to be shown in red and
		correct moves in green.
	- The Hint button is styled to match the primary action (`Next`) button so the
		controls feel consistent.

- Interaction and lifecycle
	- Pressing the Hint button requests the from-square from the server via
		`POST /puzzle_hint` (the frontend sends the current puzzle id). The server
		marks the puzzle as having had a hint used in the session so server-side
		rules can be applied on answer submission.
	- The blue hint highlight is temporary: it lasts ~3 seconds, and is removed
		immediately when the user begins interacting with the board (pointerdown or
		drag). This works across mouse and touch devices (pointer events are used).
	- The Hint button is disabled after the puzzle is answered (correct or
		incorrect) and is only re-enabled when the next puzzle is loaded.

- Server-side enforcement
	- The server ignores any client-supplied hint flag and instead uses a
		session-scoped record (`session['hints_used']`) set when `POST /puzzle_hint`
		is called. This prevents clients from spoofing hint usage.
	- When a puzzle answer is checked (`POST /check_puzzle`), if a hint was used
		the server caps XP gain for that answer to at most 1 (or 0 if no XP would
		otherwise be awarded) and will not increment the user's consecutive puzzle
		streak. Badges and daily streaks are still calculated based on the
		server-side counters.

	Note for maintainers:
	- The server exposes small helpers in `backend.py` for session hint tracking
	  (`_mark_hint_used`, `_is_hint_used`, `_clear_hint_used`) and SAN normalization
	  (`_normalize_san`, `_strip_move_number`). These are implementation details
	  intended to reduce duplication and make the hinting flow easier to reason
	  about when reading the code or writing tests.

Notes
- The frontend sanitizes SAN values when revealing the correct move after an
	incorrect attempt; however, the server computes hint squares deterministically
	from the stored puzzle FEN and SAN so the client never receives the full
	correct SAN unless the puzzle was answered incorrectly.
