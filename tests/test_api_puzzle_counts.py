import json
from backend import app, init_db
from pony.orm import db_session
import pytest
from datetime import datetime, timezone


def setup_module(module):
    import os
    os.environ['DATABASE_FILE'] = ':memory:'
    init_db()


def test_api_puzzle_counts_returns_counts():
    client = app.test_client()
    # enable mock login creation
    with client.session_transaction() as sess:
        sess['username'] = 'counts_user'
    # create a user and puzzles directly in DB
    from pony.orm import db_session
    from models import User, Puzzle
    now = datetime.now(timezone.utc)
    with db_session:
        u = User.get(username='counts_user')
        if not u:
            u = User(username='counts_user')
        # clear any existing puzzles for deterministic test
        for p in list(Puzzle.select(lambda p: p.user == u)):
            p.delete()
        Puzzle(user=u, game_id='g1', move_number=1, fen='a', correct_san='Nf3', tag='Blunder', time_control_type='blitz', date=now.isoformat())
        Puzzle(user=u, game_id='g2', move_number=2, fen='b', correct_san='e4', tag='Mistake', time_control_type='rapid', date=now.isoformat())
        Puzzle(user=u, game_id='g3', move_number=3, fen='c', correct_san='d4', tag='Blunder', time_control_type='blitz', date=now.isoformat())

    # query counts for blitz + Blunder
    r = client.get('/api/puzzle_counts?perf=blitz&tags=Blunder')
    assert r.status_code == 200
    data = r.get_json()
    assert data['available'] == 2
    # total should be 3
    assert data['total'] == 3
