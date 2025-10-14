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