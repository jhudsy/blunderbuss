from tasks import import_games_task
from models import init_db, User
from pony.orm import db_session


def test_import_aborts_without_token(monkeypatch):
    init_db()
    username = 'no_token_user'
    with db_session:
        u = User.get(username=username)
        if u:
            u.delete()
        u = User(username=username)
        # ensure no access token
        u.access_token = None

    # Call the task synchronously via its bound .run() (no explicit self arg)
    result = import_games_task.run(username, 'blitz', 1)
    assert isinstance(result, dict)
    assert result.get('imported', None) == 0
