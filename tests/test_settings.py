from backend import app, init_db
from pony.orm import db_session


def setup_module(module):
    init_db()


def test_settings_persistence():
    client = app.test_client()
    import os
    os.environ['ALLOW_MOCK_LOGIN'] = '1'
    r = client.get('/login?user=settuser', follow_redirects=True)
    assert r.status_code == 200
    # visit settings page
    r = client.get('/settings')
    assert r.status_code == 200
    # post new cooldown
    r = client.post('/settings', json={'cooldown': 42})
    assert r.status_code == 200
    # fetch user via API to ensure value stored
    with db_session:
        from models import User
        u = User.get(username='settuser')
        assert u.cooldown_minutes == 42


def test_settings_perf_list_post():
    client = app.test_client()
    import os
    os.environ['ALLOW_MOCK_LOGIN'] = '1'
    r = client.get('/login?user=perfuser', follow_redirects=True)
    assert r.status_code == 200
    # post perf types as JSON list
    r = client.post('/settings', json={'perf': ['classical', 'blitz'], 'days': 7})
    assert r.status_code == 200
    # verify stored via model helper
    with db_session:
        from models import User
        u = User.get(username='perfuser')
        assert 'classical' in u.perf_types
        assert 'blitz' in u.perf_types
        assert 'rapid' not in u.perf_types
