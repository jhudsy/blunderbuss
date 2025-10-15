"""Module that initializes DB mappings before the Gunicorn master imports the app.

Importing this module will call models.init_db(create_tables=False) and then
import and expose the Flask `app` from `backend.py`. The goal is to ensure the
master process has PonyORM mappings generated so worker processes inherit them
and avoid "mapping not generated" errors.
"""
from models import init_db

# Generate mapping (do not create tables here)
init_db(create_tables=False)

# Import and expose the Flask app
from backend import app  # noqa: E402,F401

__all__ = ['app']
