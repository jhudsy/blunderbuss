import os
import sys

# Prepend repository root to sys.path so tests import local modules before stdlib
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
