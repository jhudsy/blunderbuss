"""Badge catalog and metadata.

Provides a dictionary of badge metadata (icon filename and description).
"""
"""Badge catalog and metadata.

This module contains a simple in-memory catalog of badges. Each badge has
an `icon` filename (under static/img/badges/) and a short description. The
catalog is used by the gallery and detail pages.
"""
BADGES = {
    # Total-correct milestones
    'First Win': {'icon': 'first_win.svg', 'description': 'Your first correct puzzle — welcome!'},
    '3 Correct': {'icon': '3_correct.svg', 'description': '3 correct puzzles total.'},
    '5 Correct': {'icon': '5_correct.svg', 'description': '5 correct puzzles total.'},
    '10 Correct': {'icon': '10_correct.svg', 'description': '10 correct puzzle answers total.'},
    '20 Correct': {'icon': '20_correct.svg', 'description': '20 correct puzzles — steady progress.'},
    '25 Correct': {'icon': '25_correct.svg', 'description': '25 correct puzzle answers — persistent learner.'},
    '50 Correct': {'icon': '50_correct.svg', 'description': '50 correct puzzles — strong consistency.'},
    '100 Correct': {'icon': '100_correct.svg', 'description': '100 correct puzzles — impressive dedication.'},
    '200 Correct': {'icon': '200_correct.svg', 'description': '200 correct puzzles — veteran solver.'},
    '500 Correct': {'icon': '500_correct.svg', 'description': '500 correct puzzles — puzzle master in the making.'},
    '1000 Correct': {'icon': '1000_correct.svg', 'description': '1000 correct puzzles — elite practice!'},

    # Puzzle streaks (consecutive correct answers)
    '3 Streak': {'icon': '3_streak.svg', 'description': '3 correct answers in a row.'},
    '5 Streak': {'icon': '5_streak.svg', 'description': '5 correct answers in a row.'},
    '7 Streak': {'icon': '7_streak.svg', 'description': '7 correct answers in a row. Nice rhythm!'},
    '10 Streak': {'icon': '10_streak.svg', 'description': '10 correct answers in a row. Excellent streak!'},
    '15 Streak': {'icon': '15_streak.svg', 'description': '15 correct answers in a row. Focused practice.'},
    '20 Streak': {'icon': '20_streak.svg', 'description': '20 correct answers in a row. Stellar concentration.'},
    # multiples of 10 up to 100
    '30 Streak': {'icon': '30_streak.svg', 'description': '30 correct answers in a row.'},
    '40 Streak': {'icon': '40_streak.svg', 'description': '40 correct answers in a row.'},
    '50 Streak': {'icon': '50_streak.svg', 'description': '50 correct answers in a row.'},
    '60 Streak': {'icon': '60_streak.svg', 'description': '60 correct answers in a row.'},
    '70 Streak': {'icon': '70_streak.svg', 'description': '70 correct answers in a row.'},
    '80 Streak': {'icon': '80_streak.svg', 'description': '80 correct answers in a row.'},
    '90 Streak': {'icon': '90_streak.svg', 'description': '90 correct answers in a row.'},
    '100 Streak': {'icon': '100_streak.svg', 'description': '100 correct answers in a row — unstoppable!'},

    # Day streaks (calendar days with at least one correct answer)
    '1 Day Streak': {'icon': 'day_1.svg', 'description': 'Active today — nice start!'},
    '2 Day Streak': {'icon': 'day_2.svg', 'description': '2 days in a row — keep going!'},
    '3 Day Streak': {'icon': 'day_3.svg', 'description': '3 days in a row — building habit.'},
    '5 Day Streak': {'icon': 'day_5.svg', 'description': '5 consecutive days — good momentum.'},
    '10 Day Streak': {'icon': 'day_10.svg', 'description': '10 consecutive days — impressive dedication.'},
    '20 Day Streak': {'icon': 'day_20.svg', 'description': '20 consecutive days — committed learner.'},
    '40 Day Streak': {'icon': 'day_40.svg', 'description': '40 consecutive days — habit formed.'},
    '60 Day Streak': {'icon': 'day_60.svg', 'description': '60 consecutive days — remarkable consistency.'},
    '80 Day Streak': {'icon': 'day_80.svg', 'description': '80 consecutive days — extraordinary.'},
    '100 Day Streak': {'icon': 'day_100.svg', 'description': '100 consecutive days — elite commitment.'},
    '200 Day Streak': {'icon': 'day_200.svg', 'description': '200 consecutive days — legendary dedication.'},

    # XP milestones
    '50 XP': {'icon': 'xp_50.svg', 'description': 'Earned 50 XP total.'},
    '100 XP': {'icon': 'xp_100.svg', 'description': 'Earned 100 XP total.'},
    '200 XP': {'icon': 'xp_200.svg', 'description': 'Earned 200 XP total.'},
    '500 XP': {'icon': 'xp_500.svg', 'description': 'Earned 500 XP total.'},
    '1000 XP': {'icon': 'xp_1000.svg', 'description': 'Earned 1000 XP total.'},
    '2000 XP': {'icon': 'xp_2000.svg', 'description': 'Earned 2000 XP total.'},
    '5000 XP': {'icon': 'xp_5000.svg', 'description': 'Earned 5000 XP total.'},
    # dynamic XP badges beyond 5000 will use names like "10000 XP", "15000 XP" when reached
}

def get_badge_meta(name):
    return BADGES.get(name, {'icon': 'default.svg', 'description': ''})

def catalog():
    return BADGES
