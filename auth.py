import requests
import os
from datetime import datetime, timedelta


def exchange_code_for_token(code, verifier, redirect_uri):
    client_id = os.environ.get('LICHESS_CLIENT_ID')
    if not client_id:
        raise RuntimeError('LICHESS_CLIENT_ID not configured')
    resp = requests.post('https://lichess.org/api/token', data={'grant_type': 'authorization_code', 'code': code, 'redirect_uri': redirect_uri, 'client_id': client_id, 'code_verifier': verifier})
    resp.raise_for_status()
    return resp.json()


def refresh_token(refresh_token):
    # Lichess does not currently issue refresh tokens in the public API; placeholder for providers that do.
    client_id = os.environ.get('LICHESS_CLIENT_ID')
    if not client_id:
        raise RuntimeError('LICHESS_CLIENT_ID not configured')
    resp = requests.post('https://lichess.org/api/token', data={'grant_type': 'refresh_token', 'refresh_token': refresh_token, 'client_id': client_id})
    resp.raise_for_status()
    return resp.json()
