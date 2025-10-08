from pgn_parser import extract_puzzles_from_pgn
import pathlib


def test_extract_from_samples():
    pgn = pathlib.Path('examples/samples.pgn').read_text()
    puzzles = extract_puzzles_from_pgn(pgn)
    # We expect at least one puzzle with a blunder (from the sample)
    assert isinstance(puzzles, list)
    assert len(puzzles) >= 1
    for p in puzzles:
        assert 'fen' in p and 'correct_san' in p and 'game_id' in p
