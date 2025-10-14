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
- see the leaderboard
- solve puzzles

The backend endpoints for this functionality are detailed in BACKEND.md

If a user is not logged in, they should be redirected to the login page.

Since there may be a delay in logging in while the system retrieves games, a modal loading progress dialogue, showing the number of games loaded, should be displayed. Using the date of the last game will allow the dialogue to show how many more days of games there are to download.

The solving puzzle page must display the chessboard for the puzzle. When the user makes a move, feedback is given. For example, the square should turn green if the user moves correctly. If an incorrect move is chosen then 1. show the incorrect move in red, 2. delay for a bit, 3. reset the board to the previous position, 4. show the correct move (e.g., in green, animating the pieces). After a short delay enable the next button to move to the next puzzle. Pressing this button moves to the next puzzle, changing the board configuration (and resetting colors). The board should be flipped if necessary, i.e., if it is black to play. After the user tries a puzzle, a link to the game on lichess is provided.

The puzzle page should also show the game's details, i.e., who was white and black, the date the game was played, and the time control (rapid, blitz or classical). 

The user should also get feedback showing how much XP they have earned for getting the puzzle correct, together with any badges or achievements they have earned. Badges/achievements earned will not happen that often and should be displayed via a modal window. XP earned depends on puzzle cooldown; puzzles which appear less frequently (i.e., which have a low selection weight) will have a higher associated XP.

The UI should be attractive and utilise Bootstrap.

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

Notes
- The frontend sanitizes SAN values when revealing the correct move after an
	incorrect attempt; however, the server computes hint squares deterministically
	from the stored puzzle FEN and SAN so the client never receives the full
	correct SAN unless the puzzle was answered incorrectly.
