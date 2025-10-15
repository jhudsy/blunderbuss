"""Puzzle selection helpers.

Provides simple weighted-random selection, due filtering, and a cooldown-based
recent-review filter to avoid showing the same puzzle repeatedly.
"""

from datetime import datetime, timedelta, timezone
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
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(minutes=cooldown_minutes)
    # exclude puzzles reviewed after cutoff
    out = []
    for p in puzzles:
        lr = getattr(p, 'last_reviewed', None)
        if not lr:
            out.append(p)
            continue
        # lr can be an ISO string (from DB) or a datetime. Normalize to a
        # timezone-aware UTC datetime for safe comparison. If parsing fails,
        # include the puzzle to be conservative.
        try:
            if isinstance(lr, str):
                lr_dt = datetime.fromisoformat(lr)
            else:
                lr_dt = lr
            if lr_dt is None:
                out.append(p)
                continue
            if lr_dt.tzinfo is None:
                lr_dt = lr_dt.replace(tzinfo=timezone.utc)
        except Exception:
            out.append(p)
            continue
        if lr_dt <= cutoff:
            out.append(p)
    return out


def select_puzzle(user, all_puzzles, due_only=True, cooldown_minutes=10):
    # prioritize due items
    now = datetime.now(timezone.utc)
    if due_only:
        due = []
        for p in all_puzzles:
            nr = getattr(p, 'next_review', None)
            if nr is None:
                due.append(p)
                continue
            # nr can be an ISO string or a datetime: parse/normalize to an
            # aware UTC datetime before comparing. If parsing fails, mark
            # the puzzle as due to be conservative.
            try:
                if isinstance(nr, str):
                    nr_dt = datetime.fromisoformat(nr)
                else:
                    nr_dt = nr
                if nr_dt is None:
                    due.append(p)
                    continue
                if nr_dt.tzinfo is None:
                    nr_dt = nr_dt.replace(tzinfo=timezone.utc)
            except Exception:
                due.append(p)
                continue
            if nr_dt <= now:
                due.append(p)
    else:
        due = list(all_puzzles)
    # filter by user's selected tags (if any)
    # Prefer the higher-level `tag_filters` property (defined on app User).
    # For lightweight in-memory test User classes, fall back to parsing
    # `settings_tags` (JSON or CSV) if present.
    tag_filters = None
    try:
        tag_filters = getattr(user, 'tag_filters', None)
    except Exception:
        tag_filters = None
    if not tag_filters:
        try:
            raw = getattr(user, 'settings_tags', None) or '[]'
            import json
            parsed = json.loads(raw) if isinstance(raw, str) else raw
            if isinstance(parsed, list):
                tag_filters = [str(x).strip().lower() for x in parsed if x]
            else:
                tag_filters = [p.strip().lower() for p in str(raw).split(',') if p.strip()]
        except Exception:
            tag_filters = []
    if tag_filters:
        due = [p for p in due if getattr(p, 'tag', None) and str(getattr(p, 'tag')).strip().lower() in tag_filters]

    due = filter_recent(due, cooldown_minutes=cooldown_minutes)
    chosen = choose_weighted(due)
    if chosen:
        return chosen

    # fallback: try all puzzles after applying cooldown
    fallback = filter_recent(all_puzzles, cooldown_minutes=cooldown_minutes)
    return choose_weighted(fallback)
