"""Flask web application for the Chess Puzzle trainer.

This module defines the HTTP routes for login (mock and Lichess OAuth),
importing games, serving puzzles, checking answers (and updating spaced
repetition/XP/badges), and several small UI pages (puzzle, badges, settings).

The app uses PonyORM for persistence and delegates import to a background
task (Celery) when Lichess OAuth is used.
"""

from flask import Flask, jsonify, request, session, redirect, url_for, render_template
# Use models and tasks
from pony.orm import db_session, select
import os
import requests
import time
import base64
import hashlib
from datetime import datetime, timedelta
from dotenv import load_dotenv
from models import init_db, User, Puzzle, Badge
from badges import get_badge_meta, catalog
from pgn_parser import extract_puzzles_from_pgn
from auth import exchange_code_for_token, refresh_token
from tasks import import_games_task
from sr import sm2_update, quality_from_answer, xp_for_answer, badge_updates
from selection import select_puzzle

# load .env if present
load_dotenv()

import logging

# named logger for the application
logger = logging.getLogger('chesspuzzle')


def _configure_logging():
    # Send DEBUG logs to console in development
    # Allow explicit override via environment variable LOG_LEVEL or CHESSPUZZLE_LOG_LEVEL
    env_level = os.environ.get('LOG_LEVEL') or os.environ.get('CHESSPUZZLE_LOG_LEVEL')
    is_dev = (os.environ.get('FLASK_ENV') == 'development') or (os.environ.get('FLASK_DEBUG') == '1')
    if env_level:
        try:
            requested = getattr(logging, env_level.strip().upper())
        except Exception:
            # fallback to INFO if the provided value is invalid
            requested = logging.INFO
    else:
        requested = logging.DEBUG if is_dev else logging.INFO

    # Never allow DEBUG logging in production. If DEBUG was explicitly requested
    # but we're not in development mode, downgrade to INFO and remember we
    # suppressed debug to inform later.
    suppressed_debug = False
    if not is_dev and requested == logging.DEBUG:
        requested = logging.INFO
        suppressed_debug = True
    level = requested
    if not logger.handlers:
        ch = logging.StreamHandler()
        ch.setLevel(level)
        fmt = logging.Formatter('%(asctime)s %(levelname)s %(name)s: %(message)s')
        ch.setFormatter(fmt)
        logger.addHandler(ch)
    logger.setLevel(level)
    if suppressed_debug:
        logger.warning('DEBUG logging was requested via LOG_LEVEL but suppressed because FLASK_ENV is not development')

    # Expose a template/global flag that indicates whether debug-mode UI logging
    # should be enabled. This is intentionally true only for development runs so
    # frontend `console.debug` calls are suppressed in production even if
    # LOG_LEVEL was set to DEBUG.
    try:
        app.jinja_env.globals['CP_DEBUG'] = bool(is_dev)
    except Exception:
        # Jinja environment may not be available in some early import paths; ignore
        pass


def _mask_secret(s):
    try:
        s = str(s)
        if len(s) <= 8:
            return '*****'
        return s[:4] + '...' + s[-4:]
    except Exception:
        return '*****'


app = Flask(__name__, static_folder='static', template_folder='templates')
app.secret_key = os.environ.get('SECRET_KEY', os.urandom(24))

# If the app is deployed behind a reverse proxy (nginx) that sets
# X-Forwarded-Host/X-Forwarded-Proto headers, enable ProxyFix so
# url_for(..., _external=True) uses the forwarded host and scheme.
try:
    if os.environ.get('USE_PROXY_FIX') == '1':
        from werkzeug.middleware.proxy_fix import ProxyFix
        # num_proxies=1 is appropriate for a single fronting proxy; change
        # if your setup has additional layers.
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1)
        logger.info('ProxyFix enabled to respect X-Forwarded-* headers')
except Exception:
    # If werkzeug not available or ProxyFix import fails, ignore and continue
    pass

is_dev = (os.environ.get('FLASK_ENV') == 'development') or (os.environ.get('FLASK_DEBUG') == '1')

# Security: configure Flask session cookies. Use Secure cookies in production
# but allow non-secure cookies during local development so OAuth PKCE flows
# that rely on browser redirects still work when using HTTP.
app.config.update({
    'SESSION_COOKIE_SECURE': not is_dev,
    'SESSION_COOKIE_HTTPONLY': True,
    'SESSION_COOKIE_SAMESITE': 'Lax',
})

# Configure logging early
_configure_logging()


@app.route('/')
def index():
    # The front page is now the puzzle UI. Redirect to the puzzle page.
    return redirect(url_for('puzzle_page'))


@app.route('/health')
def health():
    # Simple health endpoint for container healthchecks. Keep lightweight.
    return jsonify({'status': 'ok'}), 200


@app.route('/ready')
def ready():
    """Readiness probe: check DB connectivity and Redis (if configured).

    Returns 200 when core dependencies are reachable, 503 otherwise.
    Keep checks fast and tolerant: if optional components (Redis) are not
    configured the probe will still succeed as long as the DB is reachable.
    """
    # Determine if caller requested a deeper check
    deep = request.args.get('full') in ('1', 'true', 'yes', 'on')

    # Check DB: perform a very small PonyORM query inside a db_session.
    try:
        from pony.orm import db_session
        with db_session:
            # run a tiny query that is cheap: attempt to fetch one User row
            users = User.select()[:1]
            if deep:
                # when doing a deep check, touch the result to ensure the ORM
                # materializes the row and that columns can be accessed.
                for u in users:
                    _ = getattr(u, 'username', None)
    except Exception as e:
        logger.error('Readiness DB check failed: %s', e)
        return jsonify({'ready': False, 'reason': 'db-unavailable'}), 503

    # Check Redis if configured via REDIS_HOST or REDIS_PASSWORD/REDIS_AUTH
    redis_host = os.environ.get('REDIS_HOST') or os.environ.get('REDIS') or 'redis'
    redis_port = int(os.environ.get('REDIS_PORT') or os.environ.get('REDIS_PORT_NUM') or 6379)
    redis_password = os.environ.get('REDIS_PASSWORD') or os.environ.get('REDIS_AUTH')
    # If no explicit redis host is configured and REDIS_PASSWORD is unset, skip Redis check
    if redis_host and (redis_password or os.environ.get('REDIS_HOST')):
        # Try to use redis-py if available for an authenticated PING. Fall back to a TCP connect.
        try:
            import redis as _redis
            try:
                r = _redis.Redis(host=redis_host, port=redis_port, password=redis_password, socket_connect_timeout=1, socket_timeout=1)
                if not r.ping():
                    raise RuntimeError('PING failed')
                if deep:
                    # perform a slightly deeper check when requested: INFO should return a dict
                    info = r.info()
                    if not isinstance(info, dict):
                        raise RuntimeError('INFO returned unexpected payload')
            except Exception as re:
                logger.error('Redis readiness ping failed: %s', re)
                return jsonify({'ready': False, 'reason': 'redis-unavailable'}), 503
        except Exception:
            # redis-py not installed; try a raw TCP connect as a best-effort check
            import socket
            try:
                s = socket.create_connection((redis_host, redis_port), timeout=1)
                s.close()
            except Exception as se:
                logger.error('Redis TCP readiness check failed: %s', se)
                return jsonify({'ready': False, 'reason': 'redis-unavailable'}), 503

    details = {'ready': True}
    if deep:
        details.update({'db': 'ok', 'redis': 'ok' if (redis_host and (redis_password or os.environ.get('REDIS_HOST'))) else 'skipped'})
    return jsonify(details), 200


@app.route('/login')
def login():
    # For local testing we support mock login via ?user=<username>
    # Only allow mock login when ALLOW_MOCK_LOGIN=1 or when FLASK_ENV=development
    allow_mock = (os.environ.get('ALLOW_MOCK_LOGIN') == '1') or (os.environ.get('FLASK_ENV') == 'development')
    user = request.args.get('user')
    # allow an explicit mock mode via ?mock=1
    mock_flag = request.args.get('mock')
    if user and allow_mock:
        session['username'] = user
        # create user if not exists
        with db_session:
            u = User.get(username=user)
            if not u:
                u = User(username=user)
                # default settings
                u.settings_days = 30
                u.settings_perftypes = 'blitz,rapid'
        return redirect(url_for('index'))
    # If Lichess OAuth client id is configured, prefer SSO unless mock explicitly requested
    client_id = os.environ.get('LICHESS_CLIENT_ID') or os.environ.get('LICHESS_CLIENTID')
    if client_id and not mock_flag:
        return redirect(url_for('login_lichess'))
    return render_template('login.html', allow_mock=allow_mock)


def _generate_pkce_pair():
    verifier = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b'=').decode('utf-8')
    challenge = hashlib.sha256(verifier.encode('utf-8')).digest()
    challenge = base64.urlsafe_b64encode(challenge).rstrip(b'=').decode('utf-8')
    return verifier, challenge


@app.route('/login-lichess')
def login_lichess():
    # If LICHESS_CLIENT_ID not set, redirect to mock login
    client_id = os.environ.get('LICHESS_CLIENT_ID') or os.environ.get('LICHESS_CLIENTID')
    if not client_id:
        return redirect(url_for('login'))
    verifier, challenge = _generate_pkce_pair()
    session['pkce_verifier'] = verifier
    params = {
        'client_id': client_id,
        'redirect_uri': url_for('login_callback', _external=True),
        'response_type': 'code',
        'code_challenge_method': 'S256',
        'code_challenge': challenge
    }
    return redirect('https://lichess.org/oauth?' + '&'.join(f"{k}={requests.utils.quote(v)}" for k,v in params.items()))


@app.route('/login-callback')
def login_callback():
    code = request.args.get('code')
    if not code:
        return 'Error: No code provided', 400
    verifier = session.get('pkce_verifier')
    # Helpful debug logging: show whether we have a PKCE verifier and the
    # redirect URI used for the token exchange. This distinguishes missing
    # session/cookie issues from redirect_uri mismatches returned by Lichess.
    try:
        redirect_uri = url_for('login_callback', _external=True)
    except Exception:
        redirect_uri = '<unable to build redirect_uri>'
    logger.debug('login_callback: pkce_verifier present=%s redirect_uri=%s', bool(verifier), redirect_uri)
    client_id = os.environ.get('LICHESS_CLIENT_ID') or os.environ.get('LICHESS_CLIENTID')
    if not client_id:
        return 'OAuth not configured', 500
    # exchange code for token (use helper)
    token_data = exchange_code_for_token(code, verifier, redirect_uri)
    token = token_data.get('access_token')
    refresh_t = token_data.get('refresh_token')
    expires_in = token_data.get('expires_in')
    if not token:
        return 'No access token', 400
    # fetch profile
    profile = requests.get('https://lichess.org/api/account', headers={'Authorization': f'Bearer {token}'})
    if profile.status_code != 200:
        return 'Failed to fetch profile', 400
    username = profile.json().get('username')
    logger.debug('Lichess login successful for user: %s', username)
    session['username'] = username
    with db_session:
        u = User.get(username=username)
        if not u:
            u = User(username=username)
        u.access_token = token
        # Some providers (including Lichess public OAuth) may not return a refresh_token.
        # PonyORM fields that are non-nullable cannot be assigned None, so only set when present.
        if refresh_t is not None:
            u.refresh_token = refresh_t
        if expires_in:
            u.token_expires_at = time.time() + int(expires_in)
            # enqueue Celery import task; if the broker is unavailable (e.g., no Redis
            # running in development), fall back to running the import synchronously.
            try:
                logger.debug('Enqueueing import_games_task for user=%s days=%s perftypes=%s', username, u.settings_days, u.settings_perftypes)
                # For security, do not pass access tokens into the broker. The
                # worker will read the user's token from the database.
                import_games_task.delay(username, u.settings_perftypes, u.settings_days)
            except Exception:
                # best-effort synchronous fallback for local dev/test environments
                try:
                    logger.debug('Broker unavailable, running import_games_task synchronously for user=%s', username)
                    # Call the task synchronously; task will read token from DB.
                    import_games_task.run(None, username, u.settings_perftypes, u.settings_days)
                except TypeError:
                    # Celery task may be bound (self param). Call the task function directly.
                    logger.debug('Calling import_games_task directly for user=%s', username)
                    import_games_task(username, u.settings_perftypes, u.settings_days)
    # Redirect to an importing page which polls the worker progress.
    return redirect(url_for('importing'))


# fetch/import is handled by Celery task import_games_task



@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('index'))


@app.route('/importing')
def importing():
    username = session.get('username')
    if not username:
        return redirect(url_for('login'))
    # Render a simple page that will poll the import status API
    return render_template('importing.html', username=username)


@app.route('/api/import_status')
def api_import_status():
    username = session.get('username')
    if not username:
        return jsonify({'status': 'not_logged_in'}), 401
    try:
        from pony.orm import db_session
        with db_session:
            u = User.get(username=username)
            if not u:
                return jsonify({'status': 'no_user'}), 404
            total = int(getattr(u, '_import_total', 0) or 0)
            done = int(getattr(u, '_import_done', 0) or 0)
            finished = (total > 0 and done >= total)
            return jsonify({'status': 'importing' if not finished else 'done', 'total': total, 'done': done})
    except Exception:
        logger.exception('Failed to read import status for user=%s', username)
        return jsonify({'status': 'error'}), 500


@app.route('/load_games', methods=['POST'])
def load_games():
    # expects JSON {"username": "...", "pgn": "..."}
    data = request.get_json() or {}
    username = data.get('username')
    pgn = data.get('pgn')
    if not username or not pgn:
        return jsonify({'error': 'username and pgn required'}), 400

    puzzles = extract_puzzles_from_pgn(pgn)
    logger.debug('Manual load_games called for username=%s, puzzles_found=%d', username, len(puzzles))
    with db_session:
        u = User.get(username=username)
        if not u:
            u = User(username=username)
        # Decide which puzzles to import: only puzzles where the blunder matches username
        to_insert = []
        for p in puzzles:
            p_white = (p.get('white') or '').strip()
            p_black = (p.get('black') or '').strip()
            blunder_side = p.get('side')
            is_match = False
            if blunder_side == 'white' and p_white and p_white.lower() == username.lower():
                is_match = True
            if blunder_side == 'black' and p_black and p_black.lower() == username.lower():
                is_match = True
            if is_match:
                to_insert.append(p)
            else:
                logger.debug('Manual load candidate puzzle game_id=%s move=%s: blunder by %s does not match %s san=%s', p.get('game_id'), p.get('move_number'), blunder_side, username, p.get('correct_san'))

        #to_insert = matched if matched else puzzles
        #if not matched:
        #    logger.debug('No puzzles matched username=%s; falling back to importing all %d puzzles', username, len(puzzles))

        # mark progress state
        u._import_total = len(to_insert)
        u._import_done = 0
        for p in to_insert:
            logger.debug('Manual importing puzzle game_id=%s move=%s san=%s for user=%s', p.get('game_id'), p.get('move_number'), p.get('correct_san'), username)
            Puzzle(user=u, game_id=p['game_id'], move_number=p['move_number'], fen=p['fen'], correct_san=p['correct_san'], weight=p.get('initial_weight', 1.0), white=p.get('white'), black=p.get('black'), date=p.get('date'), time_control=p.get('time_control'), time_control_type=p.get('time_control_type'), pre_eval=p.get('pre_eval'), post_eval=p.get('post_eval'), tag=p.get('tag'), severity=p.get('tag'))
            u._import_done += 1

        # Enforce per-user maximum puzzles after manual import
        try:
            max_p = int(getattr(u, 'settings_max_puzzles', 0) or 0)
        except Exception:
            max_p = 0
        if max_p and max_p > 0:
            user_puzzles = select(q for q in Puzzle if q.user == u)
            total = user_puzzles.count()
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
                        logger.exception('Failed to delete old puzzle id=%s for user=%s', getattr(old, 'id', None), username)

    return jsonify({'imported': len(puzzles)})


# /loading-progress endpoint removed; import progress polling disabled in the UI


@app.route('/get_puzzle')
def get_puzzle():
    username = session.get('username')
    if not username:
        return jsonify({'error': 'not logged in'}), 401
    with db_session:
        u = User.get(username=username)
        if not u:
            return jsonify({'error': 'user not found'}), 404
        all_qs = select(p for p in Puzzle if p.user == u)
        all_puzzles = list(all_qs)
        # Development convenience: if the user has no puzzles, try to seed from
        # examples/samples.pgn so the UI can show a demo puzzle locally.
        if not all_puzzles:
            try:
                from pathlib import Path
                sample = Path('examples/samples.pgn')
                if sample.exists():
                    pgn = sample.read_text()
                    puzzles = extract_puzzles_from_pgn(pgn)
                    matched = []
                    for p in puzzles:
                        p_white = (p.get('white') or '').strip()
                        p_black = (p.get('black') or '').strip()
                        blunder_side = p.get('side')
                        is_match = False
                        if blunder_side == 'white' and p_white and p_white.lower() == username.lower():
                            is_match = True
                        if blunder_side == 'black' and p_black and p_black.lower() == username.lower():
                            is_match = True
                        if is_match:
                            matched.append(p)
                        else:
                            logger.debug('Seed candidate puzzle game_id=%s move=%s: blunder by %s not user %s', p.get('game_id'), p.get('move_number'), blunder_side, username)

                    to_seed = matched if matched else puzzles
                    if not matched:
                        logger.debug('No seeded puzzles matched username=%s; importing all %d puzzles as fallback', username, len(puzzles))

                    for p in to_seed:
                        logger.debug('Seeding puzzle game_id=%s move=%s san=%s for user=%s', p.get('game_id'), p.get('move_number'), p.get('correct_san'), username)
                        Puzzle(user=u, game_id=p['game_id'], move_number=p['move_number'], fen=p['fen'], correct_san=p['correct_san'], weight=p.get('initial_weight', 1.0), white=p.get('white'), black=p.get('black'), date=p.get('date'), time_control=p.get('time_control'), time_control_type=p.get('time_control_type'), pre_eval=p.get('pre_eval'), post_eval=p.get('post_eval'), tag=p.get('tag'), severity=p.get('tag'))
                    all_puzzles = list(select(p for p in Puzzle if p.user == u))
                    # Enforce per-user maximum puzzles after seeding
                    try:
                        max_p = int(getattr(u, 'settings_max_puzzles', 0) or 0)
                    except Exception:
                        max_p = 0
                    if max_p and max_p > 0:
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
                                    logger.exception('Failed to delete old puzzle id=%s for user=%s', getattr(old, 'id', None), username)
            except Exception:
                # ignore seeding errors; fall through to no puzzles response
                pass
        # Honor the user's selected time controls (perf types) in settings.
        # If the user has one or more perf types selected, only puzzles whose
        # derived `time_control_type` matches one of those types will be
        # considered. If the stored settings are empty or invalid, no
        # filtering is applied.
        import json
        stored = getattr(u, 'settings_perftypes', None) or '[]'
        try:
            perf_list = json.loads(stored)
            if not isinstance(perf_list, list):
                perf_list = [p.strip().lower() for p in str(stored).split(',') if p.strip()]
        except Exception:
            perf_list = [p.strip().lower() for p in str(stored).split(',') if p.strip()]
        # normalize and filter out empty entries
        perf_list = [str(p).strip().lower() for p in perf_list if p]
        if perf_list:
            filtered = []
            for p in all_puzzles:
                t = getattr(p, 'time_control_type', None)
                if t and str(t).strip().lower() in perf_list:
                    filtered.append(p)
            all_puzzles = filtered

        if not all_puzzles:
            return jsonify({'error': 'no puzzles'}), 404
        chosen = select_puzzle(u, all_puzzles, due_only=True, cooldown_minutes=10)
        if not chosen:
            return jsonify({'error': 'no available puzzles'}), 404
        logger.debug('Selected puzzle id=%s for user=%s', getattr(chosen, 'id', None), username)
    # Do NOT include move details (correct_san, move_number) or surrounding PGN context
    # in the API response returned to the frontend. Those details are logged
    # server-side for debugging but must not be exposed to clients.
    resp = {
        'id': chosen.id,
        'fen': chosen.fen,
        'next_review': (chosen.next_review.isoformat() if chosen.next_review else None)
    }
    # include optional metadata fields if present on the Puzzle (seeded from PGN)
    for fld in ('white','black','date','time_control','time_control_type','pre_eval','post_eval','tag'):
        val = getattr(chosen, fld, None)
        if val is not None:
            resp[fld] = val
    return jsonify(resp)


@app.route('/puzzle')
def puzzle_page():
    username = session.get('username')
    if not username:
        return redirect(url_for('login'))
    return render_template('puzzle.html')


@app.route('/badges')
def badge_gallery():
    username = session.get('username')
    if not username:
        return redirect(url_for('login'))
    return render_template('badges.html')


@app.route('/badges/<path:name>')
def badge_detail(name):
    username = session.get('username')
    if not username:
        return redirect(url_for('login'))
    return render_template('badge_detail.html')


# Admin badge endpoints removed. Badges are added programmatically.


@app.route('/api/badges')
def api_badges():
    username = session.get('username')
    if not username:
        return jsonify({'error': 'not logged in'}), 401
    with db_session:
        u = User.get(username=username)
        if not u:
            return jsonify({'error': 'user not found'}), 404
        items = []
        for b in u.badges:
            meta = get_badge_meta(b.name)
            d = b.to_dict()
            d.update({'icon': meta.get('icon'), 'description': meta.get('description')})
            items.append(d)
        return jsonify({'badges': items, 'catalog': catalog()})


@app.route('/settings', methods=['GET','POST'])
def settings():
    username = session.get('username')
    if not username:
        return redirect(url_for('login'))
    with db_session:
        u = User.get(username=username)
        if request.method == 'POST':
            data = request.get_json() or {}
            days = int(data.get('days', getattr(u, 'settings_days', 30)))
            # Accept perf as a JSON list or as a CSV string for backward compatibility
            perf_raw = data.get('perf', None)
            perf_list = None
            if isinstance(perf_raw, list):
                perf_list = [str(p).strip().lower() for p in perf_raw if p]
            elif isinstance(perf_raw, str):
                perf_list = [p.strip().lower() for p in perf_raw.split(',') if p.strip()]
            else:
                # fallback to existing stored value
                try:
                    import json
                    perf_list = json.loads(u.settings_perftypes) if u.settings_perftypes else []
                except Exception:
                    perf_list = [p.strip().lower() for p in (getattr(u, 'settings_perftypes', '') or '').split(',') if p.strip()]
            cooldown = int(data.get('cooldown', getattr(u, 'cooldown_minutes', 10)))
            # tags: allow the client to send a list of desired puzzle tags
            tags_raw = data.get('tags', None)
            tags_list = None
            if isinstance(tags_raw, list):
                tags_list = [str(t).strip() for t in tags_raw if t]
            elif isinstance(tags_raw, str):
                tags_list = [t.strip() for t in tags_raw.split(',') if t.strip()]
            else:
                try:
                    import json
                    tags_list = json.loads(u.settings_tags) if u.settings_tags else []
                except Exception:
                    tags_list = [t.strip() for t in (getattr(u, 'settings_tags', '') or '').split(',') if t.strip()]
            u.settings_days = days
            # persist as JSON text so we can return a structured list later
            import json
            u.settings_perftypes = json.dumps(perf_list)
            u.settings_tags = json.dumps(tags_list)
            # persist user maximum puzzle limit (0 means unlimited)
            try:
                max_p = int(data.get('max_puzzles', getattr(u, 'settings_max_puzzles', 0) or 0))
            except Exception:
                max_p = 0
            u.settings_max_puzzles = max_p
            u.cooldown_minutes = cooldown
            return jsonify({'status': 'ok'})
        else:
            # For GET, return the perf types as a list (decoded JSON) so templates can use tojson
            import json
            stored = getattr(u, 'settings_perftypes', None) or '[]'
            try:
                perf_list = json.loads(stored)
                if not isinstance(perf_list, list):
                    # if somehow stored as CSV string, normalize it
                    perf_list = [p.strip().lower() for p in str(stored).split(',') if p.strip()]
            except Exception:
                perf_list = [p.strip().lower() for p in str(stored).split(',') if p.strip()]
            # load tags similarly
            tags_stored = getattr(u, 'settings_tags', None) or '[]'
            try:
                tags_list = json.loads(tags_stored)
                if not isinstance(tags_list, list):
                    tags_list = [t.strip() for t in str(tags_stored).split(',') if t.strip()]
            except Exception:
                tags_list = [t.strip() for t in str(tags_stored).split(',') if t.strip()]

            max_p = int(getattr(u, 'settings_max_puzzles', 0) or 0)
            # warn users when max_puzzles is set but low
            max_puzzles_warning = False
            if max_p and max_p > 0 and max_p < 10:
                max_puzzles_warning = True
            return render_template('settings.html', days=getattr(u, 'settings_days', 30), perf=perf_list, cooldown=getattr(u, 'cooldown_minutes', 10), tags=tags_list, max_puzzles=max_p, max_puzzles_warning=max_puzzles_warning)



@app.route('/api/puzzle_counts')
def api_puzzle_counts():
    """Return counts for puzzles for the current user.

    Query params:
      perf=... (repeatable)
      tags=... (repeatable)

    Returns JSON: { 'available': X, 'total': Y }
    """
    username = session.get('username')
    if not username:
        return jsonify({'error': 'not logged in'}), 401
    # read filters from query string
    perf_list = request.args.getlist('perf') or []
    tags_list = request.args.getlist('tags') or []
    # normalize
    perf_list = [str(p).strip().lower() for p in perf_list if p]
    tags_list = [str(t).strip().lower() for t in tags_list if t]
    with db_session:
        u = User.get(username=username)
        if not u:
            return jsonify({'error': 'user not found'}), 404
        # total puzzles for user
        total = select(p for p in Puzzle if p.user == u).count()
        # filtered
        filtered_q = select(p for p in Puzzle if p.user == u)
        filtered = []
        for p in list(filtered_q):
            ok = True
            if perf_list:
                t = getattr(p, 'time_control_type', None)
                if not t or str(t).strip().lower() not in perf_list:
                    ok = False
            if ok and tags_list:
                tag = getattr(p, 'tag', None)
                if not tag or str(tag).strip().lower() not in tags_list:
                    ok = False
            if ok:
                filtered.append(p)
        return jsonify({'available': len(filtered), 'total': total})





@app.route('/user_information')
def user_information():
    username = session.get('username')
    if not username:
        return jsonify({'error': 'not logged in'}), 401
    with db_session:
        u = User.get(username=username)
        if not u:
            return jsonify({'error': 'user not found'}), 404
    # Use the stored cumulative XP so the UI value never decreases due to
    # per-puzzle weight changes. Stored XP is updated on each answer in
    # /check_puzzle (u.xp = (u.xp or 0) + gained).
    xp = int(getattr(u, 'xp', 0) or 0)
    badges = []
    # calendar-day streak (days in a row with activity)
    days_streak = int(getattr(u, 'streak_days', 0) or 0)
    # puzzle streak (consecutive correct puzzles in a row)
    puzzle_streak = int(getattr(u, 'consecutive_correct', 0) or 0)
    return jsonify({'xp': xp, 'badges': badges, 'streak': days_streak, 'puzzle_streak': puzzle_streak, 'username': u.username})


@app.route('/leaderboard')
def leaderboard():
    page = int(request.args.get('page', 1))
    per = int(request.args.get('per', 20))
    with db_session:
        users = select(u for u in User)[:]
        # Use stored cumulative XP for ranking so leaderboard reflects
        # the same never-decreasing XP shown in the UI.
        scored = []
        for u in users:
            xp = int(getattr(u, 'xp', 0) or 0)
            scored.append({'username': u.username, 'xp': xp})
        scored.sort(key=lambda x: -x['xp'])
        start = (page-1)*per
        return jsonify({'total': len(scored), 'page': page, 'per': per, 'items': scored[start:start+per]})


@app.route('/leaderboard_page')
def leaderboard_page():
    username = session.get('username')
    if not username:
        return redirect(url_for('login'))
    return render_template('leaderboard.html')


@app.route('/check_puzzle', methods=['POST'])
def check_puzzle():
    data = request.get_json() or {}
    pid = data.get('id')
    san = data.get('san')
    if not pid or not san:
        return jsonify({'error': 'id and san required'}), 400
    with db_session:
        p = Puzzle.get(id=pid)
        if not p:
            return jsonify({'error': 'puzzle not found'}), 404

        logger.debug('User answering puzzle id=%s user=%s provided_san=%s correct_san=%s', pid, getattr(p.user, 'username', None), san, p.correct_san)
        correct = (san.strip() == p.correct_san.strip())
        logger.debug('Answer correctness for puzzle id=%s: %s', pid, correct)
        # determine quality and update SM-2 fields
        quality = quality_from_answer(correct, p.pre_eval, p.post_eval)
        reps, interval, ease = sm2_update(p.repetitions or 0, p.interval or 0, p.ease_factor or 2.5, quality)
        p.repetitions = reps
        p.interval = interval
        p.ease_factor = ease
        p.last_reviewed = datetime.utcnow()
        p.next_review = p.last_reviewed + timedelta(days=interval)
        if correct:
            p.successes = (p.successes or 0) + 1
        else:
            p.failures = (p.failures or 0) + 1
        # update selection weight (lower weight for well-known items)
        p.weight = max(0.1, 5.0 / (1 + reps))
        # award xp and badges (scale XP with user's cooldown and streak)
        u = p.user
        cd = getattr(u, 'cooldown_minutes', 10) or 10
        consec = int(getattr(u, 'consecutive_correct', 0) or 0)
        # compute gained XP based on pre-existing consecutive count
        gained = xp_for_answer(correct, cooldown_minutes=cd, consecutive_correct=consec)
        # apply XP immediately so badge logic can see updated value
        u.xp = (u.xp or 0) + gained
        # Update user's daily streak (number of consecutive days with activity)
        # only when the current answer is correct. Do this before badge calculation
        # so day-streak badges may be awarded in the same transaction.
        if correct:
            try:
                last_iso = getattr(u, '_last_game_date', None)
                from datetime import datetime as _dt, timedelta as _td
                today = _dt.utcnow().date()
                if last_iso:
                    try:
                        last_dt = _dt.fromisoformat(last_iso)
                        last_date = last_dt.date()
                    except Exception:
                        last_date = None
                else:
                    last_date = None

                if last_date == today:
                    # already had a correct activity today; don't change streak_days
                    pass
                elif last_date == (today - _td(days=1)):
                    # consecutive day -> increment streak
                    u.streak_days = (getattr(u, 'streak_days', 0) or 0) + 1
                else:
                    # new day after a gap (or no previous record) -> start at 1
                    u.streak_days = 1
            except Exception:
                # If anything unexpected happens, ensure we at least have a sensible default
                u.streak_days = getattr(u, 'streak_days', 0) or 0
            # Record this successful activity timestamp for future streak calculations
            u._last_game_date = datetime.utcnow().isoformat()

        if correct:
            u.correct_count = (u.correct_count or 0) + 1
            u.consecutive_correct = consec + 1
        else:
            u.consecutive_correct = 0

        # Now determine which badges (if any) should be awarded. badge_updates
        # expects the user's counters (xp, correct_count, consecutive_correct,
        # streak_days) to reflect the latest answer.
        new_badges = badge_updates(u, correct)
        if new_badges:
            for b in new_badges:
                # avoid duplicates
                exists = Badge.get(user=u, name=b)
                if not exists:
                    Badge(user=u, name=b)
        # Update user's daily streak (number of consecutive days with activity)
        # only when the current answer is correct.
        if correct:
            try:
                last_iso = getattr(u, '_last_game_date', None)
                from datetime import datetime as _dt, timedelta as _td
                today = _dt.utcnow().date()
                if last_iso:
                    try:
                        last_dt = _dt.fromisoformat(last_iso)
                        last_date = last_dt.date()
                    except Exception:
                        last_date = None
                else:
                    last_date = None

                if last_date == today:
                    # already had a correct activity today; don't change streak_days
                    pass
                elif last_date == (today - _td(days=1)):
                    # consecutive day -> increment streak
                    u.streak_days = (getattr(u, 'streak_days', 0) or 0) + 1
                else:
                    # new day after a gap (or no previous record) -> start at 1
                    u.streak_days = 1
            except Exception:
                # If anything unexpected happens, ensure we at least have a sensible default
                u.streak_days = getattr(u, 'streak_days', 0) or 0
            # Record this successful activity timestamp for future streak calculations
            u._last_game_date = datetime.utcnow().isoformat()
        # prepare response while DB session is active to avoid session-is-over errors
        resp = {
            'correct': correct,
            'new_weight': p.weight,
            'xp': u.xp,
            'badges': [b.name for b in u.badges]
        }
        # Reveal the correct SAN to the client only after an incorrect attempt.
        # We intentionally do NOT include prev/next SAN or other PGN context.
        # expose any newly awarded badges explicitly so the frontend can
        # show a modal only when new badges were earned during this answer
        if new_badges:
            resp['awarded_badges'] = new_badges

        if not correct:
            resp['correct_san'] = p.correct_san
        return jsonify(resp)


if __name__ == '__main__':
    # Initialize DB for development runs
    init_db()
    # Respect environment overrides set by run_server.sh
    host = os.environ.get('FLASK_HOST') or os.environ.get('HOST') or os.environ.get('FLASK_RUN_HOST') or '127.0.0.1'
    port = int(os.environ.get('FLASK_PORT') or os.environ.get('PORT') or os.environ.get('FLASK_RUN_PORT') or 5000)
    debug = os.environ.get('FLASK_DEBUG', '1')
    app.run(host=host, port=port, debug=(debug == '1'))
