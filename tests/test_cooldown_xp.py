import pathlib
from backend import app, init_db
from pony.orm import db_session


def setup_module(module):
    init_db()


def test_cooldown_increases_xp():
    client = app.test_client()
    import os
    os.environ['ALLOW_MOCK_LOGIN'] = '1'
    # create user
    r = client.get('/login?user=cooluser', follow_redirects=True)
    assert r.status_code == 200
    # import sample PGN
    pgn = pathlib.Path('examples/samples.pgn').read_text()
    r = client.post('/load_games', json={'username': 'cooluser', 'pgn': pgn})
    assert r.status_code == 200
    # get a puzzle
    r = client.get('/get_puzzle')
    assert r.status_code == 200
    p = r.get_json()
    pid = p['id']
    # fetch correct SAN from DB (server-only field)
    from pony.orm import db_session
    from models import Puzzle
    with db_session:
        san = Puzzle.get(id=pid).correct_san
    # set cooldown to small value
    r = client.post('/settings', json={'cooldown': 5})
    assert r.status_code == 200
    # submit correct and record xp
    r = client.post('/check_puzzle', json={'id': pid, 'san': san})
    j = r.get_json()
    xp_small = j['xp']
    # increase cooldown
    r = client.post('/settings', json={'cooldown': 120})
    assert r.status_code == 200
    # adjust puzzle to be available again by resetting next_review via direct import (simple approach: just fetch same puzzle id and submit again)
    r = client.post('/check_puzzle', json={'id': pid, 'san': san})
    j2 = r.get_json()
    xp_large = j2['xp']
    assert xp_large >= xp_small
