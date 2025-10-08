import json
from backend import app, init_db
from pony.orm import db_session
import pathlib


def setup_module(module):
    init_db()


def test_mock_login_and_import(tmp_path):
    client = app.test_client()
    import os
    os.environ['ALLOW_MOCK_LOGIN'] = '1'
    # mock login
    r = client.get('/login?user=testuser', follow_redirects=True)
    assert r.status_code == 200
    # import sample PGN
    pgn = pathlib.Path('examples/samples.pgn').read_text()
    r = client.post('/load_games', json={'username': 'testuser', 'pgn': pgn})
    assert r.status_code == 200
    data = r.get_json()
    assert data['imported'] >= 1
    # get puzzle
    r = client.get('/get_puzzle')
    assert r.status_code == 200
    p = r.get_json()
    assert 'fen' in p and 'id' in p
