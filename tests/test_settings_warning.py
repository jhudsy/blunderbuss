from backend import app, init_db
from pony.orm import db_session
from models import User


def setup_module(module):
    import os
    os.environ['DATABASE_FILE'] = ':memory:'
    init_db()


def test_settings_shows_warning_for_low_max_puzzles():
    client = app.test_client()
    # create a user with low max_puzzles
    with db_session:
        u = User.get(username='warn_user')
        if not u:
            u = User(username='warn_user')
        u.settings_max_puzzles = 5
    # set session to the user
    with client.session_transaction() as sess:
        sess['username'] = 'warn_user'
    r = client.get('/settings')
    assert r.status_code == 200
    text = r.get_data(as_text=True)
    assert 'Your maximum puzzle limit is low' in text
