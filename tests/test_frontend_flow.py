import pathlib
from backend import app, init_db


def setup_module(module):
    init_db()


def test_frontend_practice_flow():
    client = app.test_client()
    import os
    os.environ['ALLOW_MOCK_LOGIN'] = '1'
    # mock login via UI
    r = client.get('/login?user=feuser', follow_redirects=True)
    assert r.status_code == 200

    # import sample PGN via the UI-backed endpoint
    pgn = pathlib.Path('examples/samples.pgn').read_text()
    r = client.post('/load_games', json={'username': 'feuser', 'pgn': pgn})
    assert r.status_code == 200

    # navigate to puzzle page
    r = client.get('/puzzle')
    assert r.status_code == 200

    # client-side would fetch /get_puzzle (which intentionally does not include the correct move)
    r = client.get('/get_puzzle')
    assert r.status_code == 200
    j = r.get_json()
    assert 'id' in j and 'fen' in j

    # fetch the correct SAN from the DB directly (server-only field)
    from pony.orm import db_session
    from models import Puzzle
    with db_session:
        p = Puzzle.get(id=j['id'])
        correct = p.correct_san

    # simulate submitting the SAN answer (frontend would call /check_puzzle)
    r = client.post('/check_puzzle', json={'id': j['id'], 'san': correct})
    assert r.status_code == 200
    k = r.get_json()
    assert 'correct' in k and k['correct'] is True
