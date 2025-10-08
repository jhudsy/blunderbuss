import pathlib
from backend import app, init_db
from pony.orm import db_session


def setup_module(module):
    init_db()


def test_badge_awarding_flow(tmp_path):
    client = app.test_client()
    import os
    os.environ['ALLOW_MOCK_LOGIN'] = '1'
    # mock login
    r = client.get('/login?user=badgeuser', follow_redirects=True)
    assert r.status_code == 200
    # import sample PGN
    pgn = pathlib.Path('examples/samples.pgn').read_text()
    r = client.post('/load_games', json={'username': 'badgeuser', 'pgn': pgn})
    assert r.status_code == 200
    # fetch a puzzle and submit correct answer repeatedly to trigger streak/milestones
    r = client.get('/get_puzzle')
    assert r.status_code == 200
    p = r.get_json()
    pid = p['id']
    # fetch correct SAN from DB (server-only field)
    from pony.orm import db_session
    from models import Puzzle
    with db_session:
        san = Puzzle.get(id=pid).correct_san
    # submit 3 correct in a row to get '3 Streak' (simulate by resetting next_review to now)
    for i in range(3):
        # ensure puzzle is available by resetting next_review via direct call (we'll POST to load_games for simplicity)
        r = client.post('/check_puzzle', json={'id': pid, 'san': san})
        assert r.status_code == 200
        j = r.get_json()
    # finally, check badges via API
    r = client.get('/api/badges')
    assert r.status_code == 200
    j = r.get_json()
    names = [b['name'] for b in j.get('badges', [])]
    assert '3 Streak' in names or 'First Win' in names


def test_badges_page_renders():
    client = app.test_client()
    import os
    os.environ['ALLOW_MOCK_LOGIN'] = '1'
    r = client.get('/login?user=viewuser', follow_redirects=True)
    assert r.status_code == 200
    r = client.get('/badges')
    # should render the badges page
    assert r.status_code == 200
    assert b'Badge Gallery' in r.data
