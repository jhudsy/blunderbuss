#!/usr/bin/env python3
"""Test script to debug previous_fen generation"""

import sys
from pgn_parser import extract_puzzles_from_pgn

# Sample PGN with a blunder
test_pgn = """
[Event "Rated Blitz game"]
[Site "https://lichess.org/abc123"]
[White "Player1"]
[Black "Player2"]
[Result "0-1"]
[UTCDate "2024.01.01"]
[UTCTime "12:00:00"]
[WhiteElo "1500"]
[BlackElo "1500"]
[TimeControl "300+0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 { [%eval 0.3] } 10. d4?? { [%eval -2.5] Blunder. Best: d3 } 10... Nxe4 0-1
"""

print("Testing pgn_parser.extract_puzzles_from_pgn()")
print("=" * 60)

puzzles = extract_puzzles_from_pgn(test_pgn)

print(f"\nFound {len(puzzles)} puzzle(s)\n")

for i, p in enumerate(puzzles, 1):
    print(f"Puzzle {i}:")
    print(f"  game_id: {p.get('game_id')}")
    print(f"  move_number: {p.get('move_number')}")
    print(f"  fen: {p.get('fen')}")
    print(f"  previous_fen: {p.get('previous_fen')}")
    print(f"  correct_san: {p.get('correct_san')}")
    print(f"  side: {p.get('side')}")
    print(f"  tag: {p.get('tag')}")
    print()
