"""Shared importer utilities for converting PGN into Puzzle rows.

This module centralizes the logic used by both the Celery task and the
manual `/load_games` endpoint (and the seeding path inside `get_puzzle`).
It intentionally contains no side-effects like enqueuing tasks.
"""
from pony.orm import db_session
from pgn_parser import extract_puzzles_from_pgn
from models import User, Puzzle
import logging

logger = logging.getLogger('chesspuzzle.importer')


def import_puzzles_for_user(username, pgn, match_username=True):
    """Import puzzles from `pgn` for user `username`.

    If `match_username` is True, only puzzles where the blundering side
    matches the given username will be imported. Returns a tuple
    (imported_count, total_candidates).
    """
    puzzles = extract_puzzles_from_pgn(pgn)
    logger.debug('Importer: parsed %d puzzles for username=%s', len(puzzles), username)
    with db_session:
        u = User.get(username=username)
        if not u:
            u = User(username=username)
        to_insert = []
        for p in puzzles:
            p_white = (p.get('white') or '').strip()
            p_black = (p.get('black') or '').strip()
            blunder_side = p.get('side')
            is_match = False
            if not match_username:
                is_match = True
            else:
                if blunder_side == 'white' and p_white and p_white.lower() == username.lower():
                    is_match = True
                if blunder_side == 'black' and p_black and p_black.lower() == username.lower():
                    is_match = True
            if is_match:
                to_insert.append(p)
            else:
                logger.debug('Importer: skipped puzzle game_id=%s move=%s blunder=%s for user=%s', p.get('game_id'), p.get('move_number'), blunder_side, username)

        # mark progress
        u._import_total = len(to_insert)
        u._import_done = 0
        for p in to_insert:
            prev_fen_val = p.get('previous_fen')
            logger.info('Importer: inserting puzzle game_id=%s move=%s for user=%s, previous_fen=%s (type=%s)', 
                       p.get('game_id'), p.get('move_number'), username, 
                       str(prev_fen_val)[:60] if prev_fen_val else 'None',
                       type(prev_fen_val).__name__)
            # avoid inserting the same game_id+move_number twice for the same user
            existing = Puzzle.get(user=u, game_id=p['game_id'], move_number=p['move_number'])
            if existing:
                logger.debug('Importer: skipping duplicate puzzle for user=%s game_id=%s move=%s (already exists)', username, p.get('game_id'), p.get('move_number'))
                u._import_done += 1
                continue
            created_puzzle = Puzzle(user=u, game_id=p['game_id'], move_number=p['move_number'], fen=p['fen'], previous_fen=p.get('previous_fen'), correct_san=p['correct_san'], weight=p.get('initial_weight', 1.0), white=p.get('white'), black=p.get('black'), date=p.get('date'), time_control=p.get('time_control'), time_control_type=p.get('time_control_type'), pre_eval=p.get('pre_eval'), post_eval=p.get('post_eval'), tag=p.get('tag'), severity=p.get('tag'))
            logger.info('Importer: created puzzle with id=%s, previous_fen=%s', 
                       created_puzzle.id if hasattr(created_puzzle, 'id') else 'unknown',
                       str(created_puzzle.previous_fen)[:60] if created_puzzle.previous_fen else 'None')
            u._import_done += 1

        # enforce per-user maximum puzzles
        try:
            max_p = int(getattr(u, 'settings_max_puzzles', 0) or 0)
        except Exception:
            max_p = 0
        if max_p and max_p > 0:
            # use a safe query to count and optionally delete oldest puzzles
            from pony.orm import select
            total = select(q for q in Puzzle if q.user == u).count()
            if total > max_p:
                to_delete = total - max_p
                ordered = list(select(q for q in Puzzle if q.user == u))
                ordered.sort(key=lambda x: (getattr(x, 'date') or '', getattr(x, 'id') or 0))
                deleted = 0
                for old in ordered:
                    if deleted >= to_delete:
                        break
                    try:
                        old.delete()
                        deleted += 1
                    except Exception:
                        logger.exception('Importer: failed to delete old puzzle id=%s for user=%s', getattr(old, 'id', None), username)

    return len(to_insert), len(puzzles)
