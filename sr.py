"""Spaced repetition (SM-2 inspired) helpers, XP calculations and badge rules.

This module contains a compact implementation of the SM-2 algorithm used to
schedule puzzle reviews, plus helper functions to compute XP and determine
which badges (if any) should be awarded after an answer.
"""

from datetime import datetime, timedelta


def sm2_update(repetitions, interval, ease, quality):
    """SM-2 algorithm update step. Quality 0-5.

    Returns a tuple: (new_repetitions, new_interval_days, new_ease_factor).
    If quality < 3 the algorithm treats the item as forgotten and resets
    the repetition count, otherwise repeats and intervals are adjusted as in SM-2.
    """
    if quality < 3:
        repetitions = 0
        interval = 1
    else:
        repetitions += 1
        if repetitions == 1:
            interval = 1
        elif repetitions == 2:
            interval = 6
        else:
            interval = int(round(interval * ease))
    # update ease factor
    ease = max(1.3, ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)))
    return repetitions, interval, ease


def quality_from_answer(correct, pre_eval=None, post_eval=None):
    """Map correctness and engine-eval swing to a quality (0-5).

    We give a low quality for incorrect answers. For correct answers we
    return a high quality (4) and promote to 5 if the engine eval swing
    between pre/post positions indicates a substantial recovery.
    """
    if not correct:
        return 2
    # correct -> at least 4; if eval swing was large (user recovered from big mistake) give 5
    if pre_eval is not None and post_eval is not None:
        swing = abs(pre_eval - post_eval)
        if swing > 3.0:
            return 5
    return 4


def xp_for_answer(correct, cooldown_minutes=10, consecutive_correct=0):
    """Compute XP gained for an answer.

    - base is 10 for a correct answer (0 for incorrect)
    - XP scales with the square-root of cooldown (so waiting longer is rewarded)
    - a small streak multiplier gives incremental bonus for consecutive correct answers
    """
    # award XP only for correct answers; incorrect answers do not deduct XP
    base = 10 if correct else 0
    # avoid tiny cooldowns collapsing the score
    scale = max(0.5, (cooldown_minutes / 10.0) ** 0.5)
    # streak bonus: ~6% per correct up to a 75% boost
    streak_bonus = 1 + min(0.75, consecutive_correct * 0.06)
    return int(round(base * scale * streak_bonus))


def badge_updates(user, correct):
    """Return list of badge names to award based on the user's current counters.
    This function expects the user's counters to already reflect the latest answer (post-increment).
    """
    new = []
    if not correct:
        return new
    # treat user.correct_count, consecutive_correct and streak_days as already incremented by caller
    c = int(getattr(user, 'correct_count', 0) or 0)
    cons = int(getattr(user, 'consecutive_correct', 0) or 0)
    days = int(getattr(user, 'streak_days', 0) or 0)
    xp = int(getattr(user, 'xp', 0) or 0)

    # First win: support both styles (caller may have or not have incremented counters)
    if c <= 1:
        new.append('First Win')

    # small milestones
    if c == 3:
        new.append('3 Correct')
    if c == 5:
        new.append('5 Correct')
    if c == 10:
        new.append('10 Correct')
    if c == 20:
        new.append('20 Correct')
    if c == 25:
        new.append('25 Correct')
    if c == 50:
        new.append('50 Correct')
    if c == 100:
        new.append('100 Correct')
    if c == 200:
        new.append('200 Correct')
    if c == 500:
        new.append('500 Correct')
    if c == 1000:
        new.append('1000 Correct')

    # puzzle streaks (consecutive correct answers)
    streak_tiers = [3,5,7,10,15,20,30,40,50,60,70,80,90,100]
    for t in streak_tiers:
        if cons == t:
            new.append(f'{t} Streak')

    # day streaks (calendar-day streaks)
    day_tiers = [1,2,3,5,10,20,40,60,80,100,200]
    for d in day_tiers:
        if days == d:
            new.append(f'{d} Day Streak' if d != 1 else '1 Day Streak')

    # XP milestones
    xp_tiers = [50,100,200,500,1000,2000,5000]
    for x in xp_tiers:
        if xp >= x and xp == x:
            new.append(f'{x} XP')

    # dynamic XP badges: award for exact multiples of 5000 beyond the catalog (e.g., 10000,15000...)
    if xp > 5000 and xp % 5000 == 0:
        new.append(f'{xp} XP')

    return new
