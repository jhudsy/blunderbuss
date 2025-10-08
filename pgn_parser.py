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
        prev_san = None
        while not node.is_end():
            next_node = node.variation(0)
            move = next_node.move
            comment = (next_node.comment or '')
            meta = parse_comment_for_eval(comment)
            # only treat comments that are explicitly tagged as blunder/mistake
            if meta and (meta.get('tag') or '').lower() in ('blunder', 'mistake'):
                pre = meta['pre_eval']
                post = meta['post_eval']
                # Apply the rules from BACKEND.md:
                # - prioritize blunders where eval goes from positive to negative
                # - ignore blunders where pre_eval < -1.5 and goes to a larger negative
                # Rule: ignore cases where the position was already deeply
                # unfavorable (pre < -1.5) and it becomes even worse — not a good teaching puzzle
                if pre < -1.5 and post < pre:
                    pass
                else:
                    fen = board.fen()
                    # Determine the correct SAN: prefer a suggested SAN from the
                    # comment (human/editor may include the "best" move), otherwise
                    # fall back to the SAN of the actual move played (the blunder).
                    suggested = meta.get('suggested')
                    if suggested:
                        san = suggested
                    else:
                        san = board.san(move)
                    # compute next SAN if available
                    next_san = None
                    if next_node.variations:
                        try:
                            # get the move after the current one
                            next_next = next_node.variation(0)
                            if next_next is not None and next_next.move is not None:
                                tmp = board.copy()
                                tmp.push(move)
                                next_san = tmp.san(next_next.move)
                        except Exception:
                            next_san = None

                    # initial weight: higher if big positive->negative swing
                    swing = pre - post
                    if pre > 0 and post < 0:
                        initial_weight = max(5.0, swing * 2.0)
                    else:
                        # smaller weight for less dramatic
                        initial_weight = max(1.0, swing)
                    # attach some common PGN header metadata if available
                    # determine which side made the move (the side to move on this board)
                    side = 'white' if board.turn else 'black'
                    puzzle = {
                        'game_id': game_id,
                        'move_number': board.fullmove_number,
                        'fen': fen,
                        'correct_san': san,
                        'pre_eval': pre,
                        'post_eval': post,
                        'tag': meta.get('tag'),
                        'initial_weight': float(initial_weight),
                        'side': side,
                        'prev_san': prev_san,
                        'next_san': next_san
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
                    logger.debug('Found puzzle game_id=%s move=%s pre=%s post=%s tag=%s prev_san=%s san=%s next_san=%s', game_id, board.fullmove_number, pre, post, meta.get('tag'), prev_san, san, next_san)
                    games.append(puzzle)
            board.push(move)
            # update prev_san for the next loop iteration
            try:
                prev_san = board.san(move)
            except Exception:
                prev_san = None
            node = next_node

    return games


if __name__ == '__main__':
    import sys
    txt = open(sys.argv[1]).read()
    import json
    print(json.dumps(extract_puzzles_from_pgn(txt), indent=2))
