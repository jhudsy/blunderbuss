import json
from datetime import datetime, timedelta, timezone
from pony.orm import Database, Required, Optional, db_session, Set

# We'll recreate a minimal in-memory mapping to test pruning behaviour

def setup_in_memory_db():
    db = Database()

    class User(db.Entity):
        username = Required(str)
        settings_max_puzzles = Optional(int, default=0)
        puzzles = Set('Puzzle')

    class Puzzle(db.Entity):
        user = Required(User)
        fen = Optional(str)
        date = Optional(str)

    db.bind(provider='sqlite', filename=':memory:')
    db.generate_mapping(create_tables=True)
    return db, User, Puzzle


def test_pruning_orders_by_date():
    db, User, Puzzle = setup_in_memory_db()
    now = datetime.now(timezone.utc)
    with db_session:
        u = User(username='bob', settings_max_puzzles=2)
        # create three puzzles with different dates: oldest, middle, newest
        p_old = Puzzle(user=u, fen='a', date=(now - timedelta(days=10)).isoformat())
        p_mid = Puzzle(user=u, fen='b', date=(now - timedelta(days=5)).isoformat())
        p_new = Puzzle(user=u, fen='c', date=(now - timedelta(days=1)).isoformat())

        # simulate pruning logic: order by date then id and delete oldest until within limit
        all_puzzles = list(select_p for select_p in Puzzle.select() if select_p.user == u)
        # sort by date (oldest first)
        ordered = sorted(all_puzzles, key=lambda x: (getattr(x, 'date') or '', getattr(x, 'id') or 0))
        # delete oldest until only 2 left
        to_delete = len(ordered) - u.settings_max_puzzles
        deleted = 0
        for old in ordered:
            if deleted >= to_delete:
                break
            old.delete()
            deleted += 1

        remaining = list(Puzzle.select(lambda p: p.user == u))
        remaining_fens = set(r.fen for r in remaining)
        assert remaining_fens == {'b', 'c'}


if __name__ == '__main__':
    test_pruning_orders_by_date()
    print('ok')
