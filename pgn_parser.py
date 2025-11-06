"""PGN parsing helpers (renamed to avoid stdlib shadowing).

This module uses python-chess to parse PGN text and extract puzzle-worthy
positions annotated with engine evals or human commentary. It recognizes
comments that include pre/post engine evaluations and tags like "blunder".
"""

import chess.pgn
import io
import re
import logging

logger = logging.getLogger('chesspuzzle.pgn_parser')


# Accept both ASCII '->' and unicode right arrow '→'
EVAL_RE = re.compile(r"\(?\s*(?P<pre>[-0-9.]+)\s*(?:->|→)\s*(?P<post>[-0-9.]+)\s*\)?", re.IGNORECASE)

# SAN-like token (covers simple SAN and castling). We'll use this to find
# suggested/best moves mentioned in human comments like "f6 was best" or
# "Best: Nf3".
SAN_TOKEN = r'(?:O-O-O|O-O|[KQRNB]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRNB])?[+#]?)'
SAN_RE = re.compile(SAN_TOKEN)


def extract_suggested_san(comment: str):
    """Try to find a suggested/best SAN inside a comment string.

    Looks for patterns like "Best: f6", "f6 was best", "best move was Nf3",
    or falls back to the first SAN-like token when the word "best" appears.
    Returns the SAN string (as it appears in the comment) or None.
    """
    if not comment:
        return None
    lower = comment.lower()
    # common patterns: 'best: <san>' or '<san> was best' or 'best move was <san>'
    m = re.search(r"best\s*[:\-]?\s*" + SAN_TOKEN, comment, re.IGNORECASE)
    if m:
        mm = SAN_RE.search(m.group(0))
        if mm:
            return mm.group(0)

    m2 = re.search(SAN_TOKEN + r"\s*(?:was|is)\s*best", comment, re.IGNORECASE)
    if m2:
        mm = SAN_RE.search(m2.group(0))
        if mm:
            return mm.group(0)

    m3 = re.search(r"best move (?:was|is)\s*" + SAN_TOKEN, comment, re.IGNORECASE)
    if m3:
        mm = SAN_RE.search(m3.group(0))
        if mm:
            return mm.group(0)

    # as a last resort, if the comment contains the word 'best' return the first SAN-like token
    if 'best' in lower:
        mm = SAN_RE.search(comment)
        if mm:
            return mm.group(0)

    return None


def parse_comment_for_eval(comment: str):
    if not comment:
        return None
    # find pre/post evals anywhere in the comment
    m = EVAL_RE.search(comment)
    pre = post = None
    if m:
        try:
            pre = float(m.group('pre'))
            post = float(m.group('post'))
        except Exception:
            pre = post = None

    # detect tag words anywhere in comment
    tag = None
    lower = comment.lower()
    if 'blunder' in lower:
        tag = 'Blunder'
    elif 'mistake' in lower:
        tag = 'Mistake'
    elif 'inaccuracy' in lower:
        tag = 'Inaccuracy'
    elif 'error' in lower:
        tag = 'Error'

    # also try to extract a suggested SAN from the comment (e.g. "f6 was best")
    suggested = extract_suggested_san(comment)

    if pre is None and post is None and tag is None and suggested is None:
        return None

    return {'pre_eval': pre, 'post_eval': post, 'tag': tag, 'suggested': suggested}


def extract_puzzles_from_pgn(pgn_text):
    """Parse PGN text and extract puzzle-worthy positions.

    Returns list of dicts: {game_id, move_number, fen, correct_san, pre_eval, post_eval, tag, initial_weight}
    """
    games = []
    pgn_io = io.StringIO(pgn_text)
    # iterate games, nodes and look for comment meta that indicate mistakes/blunders
    while True:
        game = chess.pgn.read_game(pgn_io)
        if game is None:
            break
        game_id = game.headers.get('GameId', game.headers.get('Site', 'unknown'))
        node = game
        board = game.board()
    # prev_san/next_san bookkeeping removed; we no longer track surrounding SANs
        while not node.is_end():
            next_node = node.variation(0)
            move = next_node.move
            comment = (next_node.comment or '')
            meta = parse_comment_for_eval(comment)
            # only treat comments that are explicitly tagged as blunder/mistake
            if meta and (meta.get('tag') or '').lower() in ('blunder', 'mistake','inaccuracy'):
                pre = meta['pre_eval']
                post = meta['post_eval']
                # New selection rules (see docs/BACKEND.md):
                # - Prioritize blunders where the engine evaluation changes sign
                #   (e.g., positive -> negative or negative -> positive).
                # - Ignore blunders where the position was already deeply
                #   unfavorable (abs(pre_eval) > 2.0), the sign does NOT change,
                #   and the magnitude of the evaluation increases (abs(post) > abs(pre)).
                #   These are long-term losing positions and not good teaching puzzles.
                skip_puzzle = False
                sign_change = False
                if pre is not None and post is not None:
                    try:
                        sign_change = (pre * post) < 0
                    except Exception:
                        sign_change = False
                    if (abs(pre) > 2.0) and (not sign_change) and (abs(post) > abs(pre)):
                        # skip this candidate (deep, non-sign-changing worsening)
                        skip_puzzle = True

                if not skip_puzzle:
                    # Capture the FEN BEFORE the move (the position the opponent was in)
                    previous_fen = board.fen()
                    
                    # The correct_san should be the BEST move (what the user should find)
                    # This comes from the comment's suggested move (e.g., "Best: Nf3")
                    suggested = meta.get('suggested')
                    if not suggested:
                        # If there's no suggested best move in the comment, we can't
                        # create a meaningful puzzle - skip this position
                        logger.debug('Skipping puzzle at game_id=%s move=%s: no suggested best move in comment', game_id, board.fullmove_number)
                        board.push(move)
                        node = next_node
                        continue
                    
                    correct_san = suggested
                    
                    # Now get the FEN AFTER the blunder move (where the puzzle starts)
                    board_copy = board.copy()
                    board_copy.push(move)
                    fen = board_copy.fen()
                    # next_san computation removed

                    # initial weight: use the magnitude of the eval swing.
                    # Give a stronger boost when the eval sign changes (these
                    # typically represent decisive tactical moments).
                    try:
                        swing = abs((pre or 0.0) - (post or 0.0))
                    except Exception:
                        swing = 0.0
                    if sign_change:
                        initial_weight = max(5.0, swing * 2.0)
                    else:
                        # smaller weight for less dramatic, non-sign-changing swings
                        initial_weight = max(1.0, swing)
                    # attach some common PGN header metadata if available
                    # determine which side made the move (the side to move on the PREVIOUS board)
                    side = 'white' if board.turn else 'black'
                    puzzle = {
                        'game_id': game_id,
                        'move_number': board.fullmove_number,
                        'fen': fen,
                        'previous_fen': previous_fen,
                        'correct_san': correct_san,
                        'pre_eval': pre,
                        'post_eval': post,
                        'tag': meta.get('tag'),
                        'initial_weight': float(initial_weight),
                        'side': side,
                        # prev/next SAN removed: no longer stored
                    }
                    # common PGN headers we may want to surface in the UI
                    headers = game.headers
                    if headers.get('White'): puzzle['white'] = headers.get('White')
                    if headers.get('Black'): puzzle['black'] = headers.get('Black')
                    if headers.get('Date'): puzzle['date'] = headers.get('Date')
                    if headers.get('TimeControl'):
                        puzzle['time_control'] = headers.get('TimeControl')
                        # derive a human-friendly time control classification from TimeControl header
                        tc_raw = headers.get('TimeControl')
                        try:
                            if tc_raw and isinstance(tc_raw, str) and '+' in tc_raw:
                                parts = tc_raw.split('+')
                                first = int(parts[0])
                                # classify in seconds
                                if first < 180:
                                    tc_type = 'Bullet'
                                elif 180 <= first <= 599:
                                    tc_type = 'Blitz'
                                elif 600 <= first <= 1799:
                                    tc_type = 'Rapid'
                                else:
                                    tc_type = 'Classical'
                                puzzle['time_control_type'] = tc_type
                        except Exception:
                            # ignore parsing errors and leave time_control_type absent
                            pass
                    logger.debug('Found puzzle game_id=%s move=%s pre=%s post=%s tag=%s correct_san=%s', game_id, board.fullmove_number, pre, post, meta.get('tag'), correct_san)
                    games.append(puzzle)
            board.push(move)
            # prev_san bookkeeping removed
            node = next_node

    return games


if __name__ == '__main__':
    import sys
    txt = open(sys.argv[1]).read()
    import json
    print(json.dumps(extract_puzzles_from_pgn(txt), indent=2))
