"""Puzzle selection helpers.

Provides simple weighted-random selection, due filtering, and a cooldown-based
recent-review filter to avoid showing the same puzzle repeatedly.
"""

from datetime import datetime, timedelta
import random


def choose_weighted(lst):
    if not lst:
        return None
    total = sum(getattr(p, 'weight', 1.0) for p in lst)
    if total <= 0:
        return random.choice(lst)
    r = random.random() * total
    upto = 0
    for p in lst:
        upto += getattr(p, 'weight', 1.0)
        if upto >= r:
            return p
    return lst[-1]


def filter_recent(puzzles, cooldown_minutes=10):
    now = datetime.utcnow()
    cutoff = now - timedelta(minutes=cooldown_minutes)
    # exclude puzzles reviewed after cutoff
    return [p for p in puzzles if (not getattr(p, 'last_reviewed', None)) or p.last_reviewed <= cutoff]


def select_puzzle(user, all_puzzles, due_only=True, cooldown_minutes=10):
    # prioritize due items
    now = datetime.utcnow()
    if due_only:
        due = [p for p in all_puzzles if (p.next_review is None or p.next_review <= now)]
    else:
        due = list(all_puzzles)

    due = filter_recent(due, cooldown_minutes=cooldown_minutes)
    chosen = choose_weighted(due)
    if chosen:
        return chosen

    # fallback: try all puzzles after applying cooldown
    fallback = filter_recent(all_puzzles, cooldown_minutes=cooldown_minutes)
    return choose_weighted(fallback)
