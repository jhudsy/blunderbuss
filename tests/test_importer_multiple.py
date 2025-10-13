from importer import import_puzzles_for_user
from pgn_parser import extract_puzzles_from_pgn
from models import init_db
from pony.orm import db_session
from models import User, Puzzle
import pathlib


def test_parser_multiple_candidates_in_game():
    pgn = pathlib.Path('examples/samples.pgn').read_text()
    puzzles = extract_puzzles_from_pgn(pgn)
    # ensure parser returns multiple puzzles across games and at least one game has >1
    assert isinstance(puzzles, list)
    assert len(puzzles) > 3
    # group by game_id and check at least one game has multiple puzzles
    from collections import defaultdict
    by_game = defaultdict(list)
    for p in puzzles:
        by_game[p['game_id']].append(p)
    assert any(len(v) > 1 for v in by_game.values())


def test_importer_inserts_multiple_per_game(tmp_path, monkeypatch):
    # Use an in-memory sqlite DB for the test to avoid touching local state
    monkeypatch.setenv('DATABASE_FILE', ':memory:')
    init_db()
    pgn = pathlib.Path('examples/samples.pgn').read_text()
    imported, candidates = import_puzzles_for_user('jhudsy', pgn, match_username=True)
    # basic sanity
    assert candidates >= imported
    # check DB rows
    with db_session:
        u = User.get(username='jhudsy')
        assert u is not None
        rows = list(Puzzle.select(lambda p: p.user == u))
        # We expect more than one puzzle total and multiple per some games
        assert len(rows) > 1
        from collections import defaultdict
        by_game = defaultdict(list)
        for r in rows:
            by_game[r.game_id].append(r)
        assert any(len(v) > 1 for v in by_game.values())
