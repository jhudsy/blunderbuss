#!/usr/bin/env python3
"""Inject a puzzle for a specific user into the database.

This script allows you to manually add a puzzle to a user's puzzle collection.
You can either provide puzzle details via command-line arguments or interactively.

Usage:
    # Interactive mode (prompts for all values)
    python scripts/inject_puzzle.py

    # Command-line mode with all parameters
    python scripts/inject_puzzle.py --username john_doe --fen "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" --correct-san "e4" --game-id "test123" --move-number 1

    # With optional metadata
    python scripts/inject_puzzle.py -u john_doe -f "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" -s "e4" -g "test123" -m 1 --severity "Blunder" --pre-eval -2.5 --post-eval 1.0 --white "Player1" --black "Player2"

Examples:
    # Simple tactical puzzle
    python scripts/inject_puzzle.py -u alice -f "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 5" -s "Bxf7+" -g "tactics001" -m 5

    # Endgame puzzle with evaluation and severity
    python scripts/inject_puzzle.py -u bob -f "8/8/4k3/8/8/4K3/8/8 w - - 0 1" -s "Kd4" -g "endgame001" -m 1 --pre-eval 0.0 --post-eval 2.0 --severity "Mistake"
"""

import sys
import os
import argparse
from datetime import datetime, timezone

# Add parent directory to path so we can import from the main app
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models import init_db, User, Puzzle
from pony.orm import db_session, commit


def validate_fen(fen):
    """Validate FEN string using python-chess."""
    try:
        import chess
        chess.Board(fen)
        return True
    except Exception as e:
        print(f"Invalid FEN: {e}")
        return False


def validate_san(fen, san):
    """Validate that the SAN move is legal in the given position."""
    try:
        import chess
        board = chess.Board(fen)
        board.parse_san(san)
        return True
    except Exception as e:
        print(f"Invalid SAN move '{san}' for given position: {e}")
        return False


@db_session
def inject_puzzle(
    username,
    fen,
    correct_san,
    game_id,
    move_number,
    pre_eval=None,
    post_eval=None,
    severity=None,
    white=None,
    black=None,
    date=None,
    time_control=None,
    time_control_type=None,
    weight=1.0,
):
    """Inject a puzzle for the specified user.
    
    Severity field stores the classification: Blunder, Mistake, or Inaccuracy.
    """
    
    # Find the user
    user = User.get(username=username)
    if not user:
        print(f"Error: User '{username}' not found in database.")
        print("\nAvailable users:")
        for u in User.select():
            print(f"  - {u.username}")
        return False
    
    # Validate FEN
    if not validate_fen(fen):
        return False
    
    # Validate SAN move
    if not validate_san(fen, correct_san):
        return False
    
    # Check if puzzle already exists for this user
    existing = Puzzle.get(user=user, game_id=game_id, move_number=move_number)
    if existing:
        print(f"Warning: Puzzle already exists (ID: {existing.id})")
        response = input("Do you want to update it? (y/N): ").strip().lower()
        if response != 'y':
            print("Aborted.")
            return False
        # Update existing puzzle
        existing.fen = fen
        existing.correct_san = correct_san
        existing.weight = weight
        if pre_eval is not None:
            existing.pre_eval = pre_eval
        if post_eval is not None:
            existing.post_eval = post_eval
        if severity:
            existing.severity = severity
        if white:
            existing.white = white
        if black:
            existing.black = black
        if date:
            existing.date = date
        if time_control:
            existing.time_control = time_control
        if time_control_type:
            existing.time_control_type = time_control_type
        commit()
        print(f"✓ Updated puzzle ID {existing.id} for user '{username}'")
        return True
    
    # Create new puzzle - only include optional fields that are not None
    puzzle_data = {
        'user': user,
        'game_id': game_id,
        'move_number': move_number,
        'fen': fen,
        'correct_san': correct_san,
        'weight': weight,
        'repetitions': 0,
        'interval': 0,
        'ease_factor': 2.5,
        'next_review': datetime.now(timezone.utc),
        'last_reviewed': None,
        'successes': 0,
        'failures': 0,
    }
    
    # Add optional fields only if they are not None
    if pre_eval is not None:
        puzzle_data['pre_eval'] = pre_eval
    if post_eval is not None:
        puzzle_data['post_eval'] = post_eval
    if severity:
        puzzle_data['severity'] = severity
    if white:
        puzzle_data['white'] = white
    if black:
        puzzle_data['black'] = black
    if date:
        puzzle_data['date'] = date
    if time_control:
        puzzle_data['time_control'] = time_control
    if time_control_type:
        puzzle_data['time_control_type'] = time_control_type
    
    puzzle = Puzzle(**puzzle_data)
    commit()
    
    print(f"✓ Successfully injected puzzle ID {puzzle.id} for user '{username}'")
    print(f"  Game ID: {game_id}")
    print(f"  Move: {move_number}")
    print(f"  FEN: {fen}")
    print(f"  Correct move: {correct_san}")
    if severity:
        print(f"  Severity: {severity}")
    if pre_eval is not None and post_eval is not None:
        print(f"  Eval: {pre_eval} → {post_eval}")
    
    return True


def interactive_mode():
    """Prompt user for all required values interactively."""
    print("\n=== Interactive Puzzle Injection ===\n")
    
    # List available users
    with db_session:
        users = list(User.select())
        if not users:
            print("Error: No users found in database.")
            return False
        
        print("Available users:")
        for i, u in enumerate(users, 1):
            print(f"  {i}. {u.username}")
        print()
    
    # Get username
    username = input("Enter username: ").strip()
    if not username:
        print("Error: Username is required.")
        return False
    
    # Get FEN
    print("\nEnter the FEN position for the puzzle:")
    print("(e.g., 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 5')")
    fen = input("FEN: ").strip()
    if not fen:
        print("Error: FEN is required.")
        return False
    
    # Get correct move
    print("\nEnter the correct move in SAN notation:")
    print("(e.g., 'Bxf7+', 'Nf3', 'O-O', 'e4')")
    correct_san = input("Correct move: ").strip()
    if not correct_san:
        print("Error: Correct move is required.")
        return False
    
    # Get game ID
    print("\nEnter a unique game ID:")
    print("(e.g., 'manual001', 'tactics123', 'endgame_01')")
    game_id = input("Game ID: ").strip()
    if not game_id:
        print("Error: Game ID is required.")
        return False
    
    # Get move number
    move_number_str = input("Move number (default: 1): ").strip()
    move_number = int(move_number_str) if move_number_str else 1
    
    # Optional fields
    print("\n=== Optional fields (press Enter to skip) ===")
    
    pre_eval_str = input("Pre-eval (e.g., -2.5): ").strip()
    pre_eval = float(pre_eval_str) if pre_eval_str else None
    
    post_eval_str = input("Post-eval (e.g., 1.0): ").strip()
    post_eval = float(post_eval_str) if post_eval_str else None
    
    severity = input("Severity (Blunder/Mistake/Inaccuracy): ").strip() or None
    white = input("White player name: ").strip() or None
    black = input("Black player name: ").strip() or None
    date = input("Game date: ").strip() or None
    time_control = input("Time control (e.g., 180+0): ").strip() or None
    time_control_type = input("Time control type (Blitz/Rapid/Classical): ").strip() or None
    
    weight_str = input("Initial weight (default: 1.0): ").strip()
    weight = float(weight_str) if weight_str else 1.0
    
    print("\n=== Injecting puzzle... ===\n")
    
    return inject_puzzle(
        username=username,
        fen=fen,
        correct_san=correct_san,
        game_id=game_id,
        move_number=move_number,
        pre_eval=pre_eval,
        post_eval=post_eval,
        severity=severity,
        white=white,
        black=black,
        date=date,
        time_control=time_control,
        time_control_type=time_control_type,
        weight=weight,
    )


def main():
    parser = argparse.ArgumentParser(
        description='Inject a puzzle for a specific user into the database.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Interactive mode
  python scripts/inject_puzzle.py
  
  # Simple puzzle
  python scripts/inject_puzzle.py -u alice -f "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" -s "e4" -g "test001" -m 1
  
  # With evaluation and severity
  python scripts/inject_puzzle.py -u bob -f "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 5" -s "Bxf7+" -g "tactics001" -m 5 --pre-eval -2.5 --post-eval 1.0 --severity "Blunder"
        """
    )
    
    parser.add_argument('-u', '--username', help='Username to inject puzzle for')
    parser.add_argument('-f', '--fen', help='FEN position string')
    parser.add_argument('-s', '--correct-san', help='Correct move in SAN notation')
    parser.add_argument('-g', '--game-id', help='Unique game identifier')
    parser.add_argument('-m', '--move-number', type=int, help='Move number in the game')
    
    # Optional metadata
    parser.add_argument('--pre-eval', type=float, help='Pre-move evaluation')
    parser.add_argument('--post-eval', type=float, help='Post-move evaluation')
    parser.add_argument('--severity', choices=['Blunder', 'Mistake', 'Inaccuracy', 'Error'], help='Puzzle severity classification')
    parser.add_argument('--white', help='White player name')
    parser.add_argument('--black', help='Black player name')
    parser.add_argument('--date', help='Game date')
    parser.add_argument('--time-control', help='Time control (e.g., 180+0)')
    parser.add_argument('--time-control-type', choices=['Bullet', 'Blitz', 'Rapid', 'Classical'], help='Time control type')
    parser.add_argument('--weight', type=float, default=1.0, help='Initial puzzle weight (default: 1.0)')
    
    args = parser.parse_args()
    
    # Initialize database
    init_db(create_tables=False)
    
    # If no arguments provided, use interactive mode
    if not args.username:
        success = interactive_mode()
    else:
        # Validate required arguments
        if not all([args.fen, args.correct_san, args.game_id, args.move_number]):
            parser.error("When using command-line mode, --username, --fen, --correct-san, --game-id, and --move-number are required.")
        
        success = inject_puzzle(
            username=args.username,
            fen=args.fen,
            correct_san=args.correct_san,
            game_id=args.game_id,
            move_number=args.move_number,
            pre_eval=args.pre_eval,
            post_eval=args.post_eval,
            severity=args.severity,
            white=args.white,
            black=args.black,
            date=args.date,
            time_control=args.time_control,
            time_control_type=args.time_control_type,
            weight=args.weight,
        )
    
    sys.exit(0 if success else 1)


if __name__ == '__main__':
    main()
