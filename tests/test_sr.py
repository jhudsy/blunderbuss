from sr import sm2_update, quality_from_answer, xp_for_answer, badge_updates


def test_sm2_basic():
    reps, interval, ease = sm2_update(0, 0, 2.5, 5)
    assert reps == 1
    assert interval == 1
    assert ease >= 1.3


def test_quality_and_xp():
    q = quality_from_answer(True, 0.5, -2.0)
    assert q in (4,5)
    assert xp_for_answer(True) == 10
    assert xp_for_answer(False) == 0


class DummyUser:
    def __init__(self):
        self.correct_count = 0
        self.badges = ''
        self.consecutive_correct = 0


def test_badges():
    u = DummyUser()
    b = badge_updates(u, True)
    assert 'First Win' in b


def test_xp_scaling():
    # higher cooldown should increase XP
    xp1 = xp_for_answer(True, cooldown_minutes=10, consecutive_correct=0)
    xp2 = xp_for_answer(True, cooldown_minutes=40, consecutive_correct=0)
    assert xp2 >= xp1
    # streak bonus
    xp_streak = xp_for_answer(True, cooldown_minutes=10, consecutive_correct=5)
    assert xp_streak > xp1
