# Refactoring Opportunities

## puzzle.js

### 1. **Extract UI Helper Functions** (High Priority)
Multiple repetitive patterns for updating UI elements:

**Current duplicated code:**
```javascript
// Enable/disable Next button (4 occurrences)
setTimeout(()=>{ document.getElementById('next').disabled = false }, 800)
document.getElementById('next').disabled = true

// Enable/disable Hint button (multiple occurrences)
try{ const hintBtn = document.getElementById('hint'); if (hintBtn) hintBtn.disabled = true } catch(e){}

// Update XP ribbon (3 occurrences in handleCheckPuzzleResponse + other places)
try{
  if (typeof j.xp !== 'undefined'){
    const rx = document.getElementById('ribbonXP')
    if (rx){
      const prev = parseInt(rx.textContent) || 0
      rx.textContent = j.xp
      const delta = (j.xp || 0) - prev
      if (delta > 0) animateXpIncrement(delta)
    }
  }
}catch(e){}

// Refresh ribbon (multiple occurrences)
try{ if (window.refreshRibbon) window.refreshRibbon() } catch(e){}
```

**Refactored helper functions:**
```javascript
function setNextButtonEnabled(enabled, delay = 0) {
  const action = () => {
    try {
      const btn = document.getElementById('next');
      if (btn) btn.disabled = !enabled;
    } catch(e) {}
  };
  if (delay > 0) setTimeout(action, delay);
  else action();
}

function setHintButtonEnabled(enabled) {
  try {
    const btn = document.getElementById('hint');
    if (btn) btn.disabled = !enabled;
  } catch(e) {}
}

function updateRibbonXP(newXP) {
  try {
    if (typeof newXP !== 'undefined') {
      const rx = document.getElementById('ribbonXP');
      if (rx) {
        const prev = parseInt(rx.textContent) || 0;
        rx.textContent = newXP;
        const delta = (newXP || 0) - prev;
        if (delta > 0) animateXpIncrement(delta);
      }
    }
  } catch(e) {}
}

function refreshRibbon() {
  try { 
    if (window.refreshRibbon) window.refreshRibbon();
  } catch(e) {}
}

function updateUIAfterAnswer(options = {}) {
  const {
    xp,
    enableNext = false,
    enableHint = false,
    nextDelay = 800,
    showBadges = null,
    showRecordStreak = null
  } = options;
  
  if (xp !== undefined) updateRibbonXP(xp);
  refreshRibbon();
  setNextButtonEnabled(enableNext, nextDelay);
  setHintButtonEnabled(enableHint);
  
  if (showBadges && showBadges.length) {
    showBadgeToast(showBadges);
  }
  
  if (showRecordStreak) {
    try {
      showRecordToast(showRecordStreak);
    } catch(e) {
      try { alert('New record! Streak: ' + showRecordStreak); } catch(e) {}
    }
  }
}
```

**Benefits:**
- Reduces ~100 lines of repetitive code
- Single source of truth for UI updates
- Easier to add new features (e.g., animations)
- More maintainable and testable

---

### 2. **Consolidate Board Reset Logic** (Medium Priority)

**Current duplicated code:**
```javascript
// Appears in multiple places
try { board.position(startFEN) } catch (e) { console.error('Error resetting board position:', e) }
try { game.load(startFEN) } catch (e) { /* ignore */ }
```

**Refactored:**
```javascript
function resetBoard(fen) {
  try {
    board.position(fen);
  } catch (e) {
    console.error('Error resetting board position:', e);
  }
  try {
    game.load(fen);
  } catch (e) {
    // Ignore load errors
  }
}
```

---

### 3. **Extract Move Validation Logic** (Low Priority)

The SAN sanitization and move validation logic in `handleCheckPuzzleResponse` could be extracted:

```javascript
function validateAndRevealMove(san, startFEN) {
  // Sanitize SAN
  let cleanSan = (san || '').toString().trim()
    .replace(/^\d+\.*\s*/, '')
    .replace(/\.{2,}/g, '')
    .replace(/[(),;:]/g, '')
    .trim();
  
  if (window.__CP_DEBUG) console.debug('Sanitized SAN:', cleanSan);
  
  try {
    const temp = new Chess();
    temp.load(startFEN);
    const moveObj = temp.move(cleanSan, {sloppy: true});
    
    if (moveObj) {
      return revealCorrectMoveSquares(moveObj.from, moveObj.to);
    } else {
      // Fallback: scan moves list
      const moves = temp.moves({verbose: true});
      for (let m of moves) {
        if (m.san === cleanSan) {
          if (window.__CP_DEBUG) console.debug('Matched move in list:', m);
          return revealCorrectMoveSquares(m.from, m.to);
        }
      }
    }
  } catch(e) {
    console.error('Error validating move:', e);
  }
  
  return false;
}
```

---

## backend.py

### 1. **Extract User Attribute Getters** (Medium Priority)

**Current pattern (appears 20+ times):**
```python
cd = getattr(u, 'cooldown_minutes', 10) or 10
consec = int(getattr(u, 'consecutive_correct', 0) or 0)
max_attempts = getattr(u, 'settings_max_attempts', 3) or 3
```

**Refactored:**
```python
def get_user_setting(user, attr, default, type_cast=None):
    """Safe getter for user attributes with default and optional type casting."""
    value = getattr(user, attr, default) or default
    if type_cast:
        try:
            return type_cast(value)
        except (ValueError, TypeError):
            return default
    return value

# Usage:
cd = get_user_setting(u, 'cooldown_minutes', 10, int)
consec = get_user_setting(u, 'consecutive_correct', 0, int)
max_attempts = get_user_setting(u, 'settings_max_attempts', 3, int)
```

**Or use a UserSettings wrapper class:**
```python
class UserSettings:
    def __init__(self, user):
        self.user = user
    
    def get_int(self, attr, default):
        return int(getattr(self.user, attr, default) or default)
    
    def get_str(self, attr, default=''):
        return str(getattr(self.user, attr, default) or default)
    
    @property
    def cooldown_minutes(self):
        return self.get_int('cooldown_minutes', 10)
    
    @property
    def max_attempts(self):
        return max(1, min(3, self.get_int('settings_max_attempts', 3)))
    
    @property
    def consecutive_correct(self):
        return self.get_int('consecutive_correct', 0)

# Usage:
settings = UserSettings(u)
cd = settings.cooldown_minutes
max_attempts = settings.max_attempts
```

---

### 2. **Extract XP Update Logic** (Medium Priority)

**Current code (in check_puzzle):**
```python
# Lines 1076-1092 - XP update logic
u.xp = (u.xp or 0) + gained
try:
    today_iso = datetime.now(timezone.utc).date().isoformat()
    if getattr(u, 'xp_today_date', None) != today_iso:
        u.xp_today = 0
        u.xp_today_date = today_iso
    try:
        u.xp_today = (getattr(u, 'xp_today', 0) or 0) + (gained or 0)
    except Exception:
        u.xp_today = (gained or 0)
    if not getattr(u, '_first_game_date', None):
        u._first_game_date = datetime.now(timezone.utc).date().isoformat()
except Exception:
    pass
```

**Refactored:**
```python
def update_user_xp(user, gained_xp):
    """Update user XP and daily XP tracking."""
    user.xp = (user.xp or 0) + gained_xp
    
    try:
        today_iso = datetime.now(timezone.utc).date().isoformat()
        
        # Reset daily XP if it's a new day
        if getattr(user, 'xp_today_date', None) != today_iso:
            user.xp_today = 0
            user.xp_today_date = today_iso
        
        # Add to today's XP
        user.xp_today = (getattr(user, 'xp_today', 0) or 0) + (gained_xp or 0)
        
        # Record first activity date if not set
        if not getattr(user, '_first_game_date', None):
            user._first_game_date = today_iso
    except Exception as e:
        app.logger.warning(f"Error updating XP tracking: {e}")

# Usage:
update_user_xp(u, gained)
```

---

### 3. **Extract Streak Update Logic** (Low Priority)

**Current code (lines 1100-1109):**
```python
if correct:
    _record_successful_activity(u)
    try:
        best_day = int(getattr(u, 'best_streak_days', 0) or 0)
        if (getattr(u, 'streak_days', 0) or 0) > best_day:
            u.best_streak_days = (getattr(u, 'streak_days', 0) or 0)
    except Exception:
        pass
    u.correct_count = (u.correct_count or 0) + 1
    if not hint_used:
        u.consecutive_correct = consec + 1
```

**Refactored:**
```python
def update_user_streaks(user, hint_used=False):
    """Update user streak counters after a correct answer."""
    _record_successful_activity(user)
    
    # Update best day streak if current is higher
    try:
        current_streak = getattr(user, 'streak_days', 0) or 0
        best_streak = getattr(user, 'best_streak_days', 0) or 0
        if current_streak > best_streak:
            user.best_streak_days = current_streak
    except Exception as e:
        app.logger.warning(f"Error updating best streak: {e}")
    
    # Increment cumulative correct counter
    user.correct_count = (user.correct_count or 0) + 1
    
    # Only increment puzzle streak if no hint was used
    if not hint_used:
        current = int(getattr(user, 'consecutive_correct', 0) or 0)
        user.consecutive_correct = current + 1

# Usage:
if correct:
    update_user_streaks(u, hint_used)
else:
    u.consecutive_correct = 0
```

---

## Summary of Impact

### High Priority (Immediate Benefits)
1. **puzzle.js UI helpers** - Would eliminate ~100-150 lines of duplicated code
2. **Estimated reduction:** puzzle.js from 941 → ~820 lines (-13%)

### Medium Priority (Maintainability)
1. **backend.py user settings wrapper** - Makes code more readable and type-safe
2. **XP update extraction** - Centralizes business logic
3. **Estimated reduction:** backend.py minor line reduction but major readability improvement

### Low Priority (Nice to Have)
1. **Move validation extraction** - Already well-contained
2. **Streak update extraction** - Small improvement

### Total Estimated Impact
- **Lines reduced:** ~150-200 lines across both files
- **Maintainability:** Significantly improved
- **Bug resistance:** Reduced (single source of truth)
- **Testability:** Improved (smaller, focused functions)

## Recommendation

Start with **puzzle.js UI helpers refactoring** as it provides the most immediate benefit with minimal risk. The other refactorings can be done incrementally as needed.
