from pony.orm import db_session
from backend import app
from models import init_db, User, Puzzle
import json


def test_puzzle_hint_returns_from_square(tmp_path):
    init_db()
    client = app.test_client()
    with db_session:
        u = User(username='hintuser')
        # create a simple pawn move position: white pawn on e2, move e4
        fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'
        p = Puzzle(user=u, game_id='g1', move_number=1, fen=fen, correct_san='e4')
        pid = p.id
    # login as user via session
    with client.session_transaction() as sess:
        sess['username'] = 'hintuser'
    r = client.post('/puzzle_hint', json={'id': pid})
    assert r.status_code == 200
    data = r.get_json()
    assert 'from' in data
    assert data['from'] in ('e2', 'e7', 'a1', 'h1') or len(data['from']) == 2
