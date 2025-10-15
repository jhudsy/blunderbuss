import json
import tempfile
import os
from datetime import datetime, timedelta, timezone

from pony.orm import Database, Required, Optional, db_session, set_sql_debug, Set

# We can't import the project's models directly because they bind to a file DB by default.
# Create a minimal in-memory mapping compatible with selection.select_puzzle's expectations.
from selection import select_puzzle


def setup_in_memory_db():
    db = Database()

    class User(db.Entity):
        username = Required(str)
        settings_tags = Optional(str)
        puzzles = Set('Puzzle')  # Added Set relationship

    class Puzzle(db.Entity):
        user = Required(User)
        tag = Optional(str)
        fen = Optional(str)
        weight = Optional(float)
        next_review = Optional(datetime)
        last_reviewed = Optional(datetime)

    db.bind(provider='sqlite', filename=':memory:')
    db.generate_mapping(create_tables=True)
    return db, User, Puzzle

    db.bind(provider='sqlite', filename=':memory:')
    db.generate_mapping(create_tables=True)
    return db, User, Puzzle


def test_select_puzzle_respects_tags():
    db, User, Puzzle = setup_in_memory_db()
    now = datetime.now(timezone.utc)
    with db_session:
        u = User(username='alice', settings_tags=json.dumps(['Blunder']))
        # puzzles: one blunder (should be selectable), one mistake (should be filtered out)
        p1 = Puzzle(user=u, tag='Blunder', fen='1', weight=1.0, next_review=now - timedelta(days=1), last_reviewed=None)
        p2 = Puzzle(user=u, tag='Mistake', fen='2', weight=1.0, next_review=now - timedelta(days=1), last_reviewed=None)

        chosen = select_puzzle(u, [p1, p2], due_only=True, cooldown_minutes=0)
        assert chosen is not None
        assert chosen.tag.lower() == 'blunder'


if __name__ == '__main__':
    test_select_puzzle_respects_tags()
    print('ok')
