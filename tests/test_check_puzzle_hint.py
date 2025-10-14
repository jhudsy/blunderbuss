from pony.orm import db_session
from backend import app
from models import init_db, User, Puzzle


def test_check_puzzle_with_hint_caps_xp_and_no_streak_increase():
    init_db()
    client = app.test_client()
    with db_session:
        u = User(username='hinter')
        # position where correct move is e4
        fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'
        p = Puzzle(user=u, game_id='g2', move_number=1, fen=fen, correct_san='e4')
        pid = p.id
        # set some initial xp and consecutive_correct
        u.xp = 100
        u.consecutive_correct = 2
    with client.session_transaction() as sess:
        sess['username'] = 'hinter'
    # trigger hint to set session flag
    r = client.post('/puzzle_hint', json={'id': pid})
    assert r.status_code == 200
    # Now submit correct answer; frontend normally sends hint_used: true, server also records in session
    r2 = client.post('/check_puzzle', json={'id': pid, 'san': 'e4', 'hint_used': True})
    assert r2.status_code == 200
    data = r2.get_json()
    # xp should be increased by at most 1
    with db_session:
        u = User.get(username='hinter')
        assert u.xp <= 101
        # consecutive_correct should NOT have increased (remains 2)
        assert u.consecutive_correct == 2
