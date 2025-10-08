import os
import importlib
import pytest

# This test only runs when cryptography is available and ENCRYPTION_KEY env is set.
try:
    from cryptography.fernet import Fernet
    HAS_FERNET = True
except Exception:
    HAS_FERNET = False


@pytest.mark.skipif(not HAS_FERNET, reason="cryptography not available")
def test_encrypted_token_storage(monkeypatch, tmp_path):
    # generate a key for the test and set it in the environment
    key = Fernet.generate_key().decode()
    monkeypatch.setenv('ENCRYPTION_KEY', key)

    # reload models to pick up ENCRYPTION_KEY during module import
    import models as m
    importlib.reload(m)

    # Initialize DB and create a user
    m.init_db()
    username = 'enc_test_user'
    from pony.orm import db_session
    with db_session:
        # remove existing
        u = m.User.get(username=username)
        if u:
            u.delete()
        u = m.User(username=username)
        u.access_token = 'super-secret-token'
        u.refresh_token = 'super-refresh'
        # the underlying encrypted fields should not equal plaintext
        assert getattr(u, 'access_token_encrypted') is not None
        assert getattr(u, 'access_token_encrypted') != 'super-secret-token'
        # property should decrypt back to original
        assert u.access_token == 'super-secret-token'
    assert u.refresh_token == 'super-refresh'