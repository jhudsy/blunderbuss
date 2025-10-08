from celery import Celery
import os
from dotenv import load_dotenv
# Ensure environment variables from .env are loaded in worker processes
load_dotenv()
from pgn_parser import extract_puzzles_from_pgn
from models import init_db, User, Puzzle
from pony.orm import db_session
from datetime import datetime, timedelta
import requests
import logging
from dotenv import load_dotenv

# Ensure environment variables from .env are loaded in worker processes
load_dotenv()

logger = logging.getLogger('chesspuzzle.tasks')

# Celery broker URL. Prefer explicit CELERY_BROKER if provided. Otherwise
# construct a Redis URL from REDIS_HOST/REDIS_PORT/REDIS_DB and optional
# REDIS_PASSWORD sourced from the environment (e.g., .env).
CELERY_BROKER = os.environ.get('CELERY_BROKER')
if not CELERY_BROKER:
    redis_host = os.environ.get('REDIS_HOST', 'localhost')
    redis_port = os.environ.get('REDIS_PORT', '6379')
    redis_db = os.environ.get('REDIS_DB', '0')
    redis_password = os.environ.get('REDIS_PASSWORD') or os.environ.get('REDIS_AUTH')
    if redis_password:
        # URL-encode the password portion in case it contains special chars
        from urllib.parse import quote_plus
        pw = quote_plus(redis_password)
        CELERY_BROKER = f'redis://:{pw}@{redis_host}:{redis_port}/{redis_db}'
    else:
        CELERY_BROKER = f'redis://{redis_host}:{redis_port}/{redis_db}'

celery_app = Celery('chesspuzzle', broker=CELERY_BROKER)

# Allow running tasks synchronously for local dev/testing by setting
# CELERY_EAGER=1 or by using a memory broker (memory://). In eager mode,
# Celery will execute tasks immediately in the same process which avoids
# broker/network requirements during tests or lightweight development runs.
if os.environ.get('CELERY_EAGER', '0') == '1' or CELERY_BROKER.startswith('memory'):
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True


@celery_app.task(bind=True)
def import_games_task(self, username, perftypes, days):
    init_db()
    since_ms = int((datetime.utcnow() - timedelta(days=days)).timestamp() * 1000)
    # Read the user's access token from the DB rather than passing it via the broker
    with db_session:
        u = User.get(username=username)
        token = getattr(u, 'access_token', None) if u else None

    if not token:
        logger.warning('No access token available for user=%s; aborting import', username)
        return {'imported': 0}

    url = f'https://lichess.org/api/games/user/{username}?since={since_ms}&analysed=True&evals=True&literate=True&perfType="{perftypes}"'
    headers = {'Authorization': f'Bearer {token}'}
    logger.debug('Requesting games from Lichess for user=%s url=%s', username, url)
    resp = requests.get(url, headers=headers)
    logger.debug('Lichess API request performed. URL=%s Status=%s', url, getattr(resp, 'status_code', None))
    resp.raise_for_status()
    pgn = resp.text
    # Count number of games in the PGN payload for debugging/observability
    try:
        import io, chess.pgn as _pgn
        pgn_io = io.StringIO(pgn)
        game_count = 0
        while True:
            g = _pgn.read_game(pgn_io)
            if g is None:
                break
            game_count += 1
    except Exception:
        game_count = None
    logger.debug('Retrieved %d bytes of PGN for user=%s (games=%s)', len(pgn), username, game_count)
    puzzles = extract_puzzles_from_pgn(pgn)
    logger.debug('Parsed %d puzzles for user=%s', len(puzzles), username)
    with db_session:
        u = User.get(username=username)
        if not u:
            u = User(username=username)
        u._import_total = len(puzzles)
        u._import_done = 0
        for p in puzzles:
            # Only import puzzles that correspond to this user's blunder (match by username)
            p_white = (p.get('white') or '').strip()
            p_black = (p.get('black') or '').strip()
            blunder_side = p.get('side')
            # determine if the lichess username matches the side that blundered
            matched = False
            if blunder_side == 'white' and p_white and p_white.lower() == username.lower():
                matched = True
            if blunder_side == 'black' and p_black and p_black.lower() == username.lower():
                matched = True
            if not matched:
                logger.debug('Skipping puzzle game_id=%s move=%s: blunder by %s not current user %s', p.get('game_id'), p.get('move_number'), blunder_side, username)
                continue
            logger.debug('Importing puzzle game_id=%s move=%s for user=%s prev_san=%s san=%s next_san=%s', p.get('game_id'), p.get('move_number'), username, p.get('prev_san'), p.get('correct_san'), p.get('next_san'))
            Puzzle(
                user=u,
                game_id=p['game_id'],
                move_number=p['move_number'],
                fen=p['fen'],
                correct_san=p['correct_san'],
                weight=p.get('initial_weight', 1.0),
                white=p.get('white'),
                black=p.get('black'),
                date=p.get('date'),
                time_control=p.get('time_control'),
                time_control_type=p.get('time_control_type'),
                pre_eval=p.get('pre_eval'),
                post_eval=p.get('post_eval'),
                tag=p.get('tag'),
                severity=p.get('tag'),
                prev_san=p.get('prev_san'),
                next_san=p.get('next_san'),
            )
            u._import_done += 1
        u._last_game_date = datetime.utcnow().isoformat()
    return {'imported': len(puzzles)}
