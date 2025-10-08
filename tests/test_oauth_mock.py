import json
from unittest import mock
import pytest

from backend import app, init_db
from pony.orm import db_session


@pytest.fixture(autouse=True)
def _init_db():
    init_db()
    yield


def test_login_callback_with_mocked_oauth(monkeypatch):
    client = app.test_client()

    # Prepare a fake token response
    fake_token = {'access_token': 'fake-access', 'refresh_token': 'fake-refresh', 'expires_in': 3600}

    # Patch backend.exchange_code_for_token to return the fake token (backend imports it at module-level)
    import backend

    monkeypatch.setattr(backend, 'exchange_code_for_token', lambda code, verifier, redirect_uri: fake_token)

    # Patch requests.get used to fetch profile in backend.login_callback
    class FakeResp:
        def __init__(self, data, status=200):
            self._data = data
            self.status_code = status

        def json(self):
            return self._data

    def fake_get(url, headers=None):
        # return a fake profile
        return FakeResp({'username': 'oauth_user'})

    # patch the requests.get used by backend
    import requests as real_requests
    backend.requests = real_requests
    monkeypatch.setattr(backend.requests, 'get', fake_get)

    # Stub out the Celery import task so tests don't attempt to connect to Redis
    class FakeTask:
        @staticmethod
        def delay(*a, **k):
            return None

    monkeypatch.setattr(backend, 'import_games_task', FakeTask())

    # simulate that PKCE verifier is in session
    with client.session_transaction() as sess:
        sess['pkce_verifier'] = 'fakeverifier'

    # Ensure OAuth is considered configured in the test
    monkeypatch.setenv('LICHESS_CLIENT_ID', 'test-client')

    # Call the callback as if Lichess redirected with a code
    resp = client.get('/login-callback?code=somecode', follow_redirects=False)
    # Expect a redirect to index
    assert resp.status_code in (302, 303)

    # Check that the user was created in the DB and tokens stored
    with db_session:
        from models import User

        u = User.get(username='oauth_user')
        assert u is not None
        assert u.access_token == 'fake-access'
        assert u.refresh_token == 'fake-refresh'
