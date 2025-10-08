#this is a code snippet for lichess login functionality
from flask import Flask, redirect, request, session, url_for
import requests
import os
from urllib.parse import urlencode
from flask_cors import CORS
import base64
import hashlib

from models import init_db, User, Puzzle, PuzzleAttempt

app = Flask(__name__)
CORS(app)
app.secret_key = os.urandom(24)

# Initialize the database
db = init_db()

###############OAUTH/AUTHENTICATION STUFF ###############
CLIENT_ID = os.urandom(24).hex() #'dfgjkhgdfert292'  # Replace with your Lichess OAuth client ID


#the verifier is a base64 url encoded 32 byte string
verifier = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b'=').decode('utf-8')
#the challenge is the sha256 hash of the verifier, base64 url encoded

challenge = hashlib.sha256(verifier.encode('utf-8')).digest()
challenge = base64.urlsafe_b64encode(challenge).rstrip(b'=').decode('utf-8')

#render the index.html by default
@app.route('/')
def index():
    return 'Welcome to the Lichess OAuth Demo! <a href="/login">Login with Lichess</a>'

@app.route('/login')
def login():
    # Redirect the user to the Lichess OAuth authorization page
    return redirect('https://lichess.org/oauth?' + urlencode({
        'client_id': CLIENT_ID,
        'redirect_uri': url_for('callback', _external=True),
        'response_type': 'code',
        'code_challenge_method': 'S256',
        'code_challenge': challenge  # Replace with actual code challenge
    }))

@app.route('/callback')
def callback():

    # Handle the OAuth callback from Lichess
    code = request.args.get('code')
    if not code:
               return 'Error: No code provided', 400

    # Exchange the authorization code for an access token
    token_response = requests.post('https://lichess.org/api/token', data={
        'grant_type': 'authorization_code',
        'code': code,
        'redirect_uri': url_for('callback', _external=True),
        'client_id': CLIENT_ID,
        'code_verifier': verifier  # Replace with actual code verifier
    })

    print(token_response)  # Debugging line to print the response text

    if token_response.status_code != 200:
        return 'Error: Failed to obtain access token', 400

    token_data = token_response.json()
    access_token = token_data.get('access_token')

    if not access_token:
        return 'Error: No access token in response', 400

    # Use the access token to fetch the user's profile information
    profile_response = requests.get('https://lichess.org/api/account', headers={
        'Authorization': f'Bearer {access_token}'
    })

    if profile_response.status_code != 200:
        return 'Error: Failed to fetch user profile', 400

    profile_data = profile_response.json()
    username = profile_data.get('username')

    if not username:
        return 'Error: No username in profile data', 400

    # Store the username in the session
    session['username'] = username

    return f'Logged in as {username}'