import requests
import os
from datetime import datetime, timedelta


def exchange_code_for_token(code, verifier, redirect_uri):
    client_id = os.environ.get('LICHESS_CLIENT_ID')
    if not client_id:
        raise RuntimeError('LICHESS_CLIENT_ID not configured')
    resp = requests.post('https://lichess.org/api/token', data={'grant_type': 'authorization_code', 'code': code, 'redirect_uri': redirect_uri, 'client_id': client_id, 'code_verifier': verifier})
    # Surface provider error details to help debugging redirect/missing-secret issues
    if resp.status_code != 200:
        # include response text (may contain provider error description)
        raise RuntimeError(f'LICHESS token exchange failed: {resp.status_code} {resp.text}')
    return resp.json()


def refresh_token(refresh_token):
    # Lichess does not currently issue refresh tokens in the public API; placeholder for providers that do.
    client_id = os.environ.get('LICHESS_CLIENT_ID')
    if not client_id:
        raise RuntimeError('LICHESS_CLIENT_ID not configured')
    resp = requests.post('https://lichess.org/api/token', data={'grant_type': 'refresh_token', 'refresh_token': refresh_token, 'client_id': client_id})
    if resp.status_code != 200:
        raise RuntimeError(f'LICHESS refresh token failed: {resp.status_code} {resp.text}')
    return resp.json()
