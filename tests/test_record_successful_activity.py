from types import SimpleNamespace
from datetime import datetime, timedelta, timezone

from backend import _record_successful_activity


def test_record_successful_activity_same_day_no_change():
    today = datetime.now(timezone.utc).date()
    u = SimpleNamespace(streak_days=3, _last_successful_activity_date=today.isoformat())
    _record_successful_activity(u)
    # streak should remain the same when last activity is today
    assert getattr(u, 'streak_days', None) == 3
    # timestamp should be updated to a valid ISO string
    assert isinstance(getattr(u, '_last_successful_activity_date', None), str)


def test_record_successful_activity_consecutive_day_increments():
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).date()
    u = SimpleNamespace(streak_days=2, _last_successful_activity_date=yesterday.isoformat())
    _record_successful_activity(u)
    assert getattr(u, 'streak_days', None) == 3
    assert isinstance(getattr(u, '_last_successful_activity_date', None), str)


def test_record_successful_activity_no_previous_starts_at_one():
    u = SimpleNamespace(streak_days=5, _last_successful_activity_date=None)
    _record_successful_activity(u)
    # no previous successful activity -> start at 1
    assert getattr(u, 'streak_days', None) == 1
    assert isinstance(getattr(u, '_last_successful_activity_date', None), str)
