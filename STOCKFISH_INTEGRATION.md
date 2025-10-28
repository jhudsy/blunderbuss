# Stockfish Integration - Evaluation-Based Move Validation

## Overview

This branch (`feature/stockfish-evaluation`) introduces a major change to how puzzle moves are validated. Instead of requiring an exact match to a predetermined correct move (SAN comparison), the system now uses Stockfish chess engine to evaluate positions and accepts any move that maintains the win likelihood within a 10% threshold.

## Key Changes

### 1. Move Validation Formula

**Win Likelihood Calculation:**
```javascript
win_likelihood = 50 + 50 * (2 / (e^(-0.00368 * cp) + 1) - 1)
```

Where `cp` is the centipawn evaluation from Stockfish.

**Correctness Criterion:**
A move is correct if: `(move_win - initial_win) >= -10.0`

This means the win chance cannot decrease by more than 10 percentage points.

### 2. Technical Implementation

**Frontend (static/js/puzzle.js):**
- Initialize Stockfish engine in Web Worker on page load
- When user makes a move:
  1. Evaluate initial FEN position (depth 15)
  2. Evaluate FEN after move (depth 15)
  3. Calculate win likelihoods for both positions
  4. Send centipawn values to server
- Display "Analyzing position..." during evaluation
- Show win percentage changes in feedback messages

**Backend (backend.py):**
- Modified `/check_puzzle` endpoint:
  - Accepts: `initial_fen`, `move_fen`, `initial_cp`, `move_cp`
  - Calculates win likelihoods server-side (validation)
  - Returns evaluation details in response
  - No longer compares SAN strings

**Stockfish Engine:**
- File: `static/js/stockfish.js` (931KB from lichess-org)
- Runs in Web Worker (non-blocking)
- Evaluation depth: 15 (balance speed/accuracy)
- Timeout: 10 seconds per evaluation

### 3. User Experience Changes

**Correct Move Feedback:**
```
Correct! Win chance: 65% → 70% (+5%). Click Next to continue.
```

**Incorrect Move Feedback:**
```
Incorrect. Win chance dropped to 40% (-25%). You have 2 attempts remaining.
```

**Hint System:**
- Still highlights the from-square of the stored "best move"
- Users can choose alternative moves if they maintain position
- Provides guidance without requiring exact move match

### 4. Benefits

1. **Multiple Valid Moves:** Accepts any reasonable move, not just the one from PGN analysis
2. **Better Learning:** Users understand *why* their move is wrong (win % drop)
3. **Flexible Puzzles:** Same puzzle can have multiple solutions
4. **Realistic Analysis:** Uses same engine (Stockfish) as lichess analysis

## Files Modified

1. `backend.py` - Update `/check_puzzle` endpoint for evaluation-based validation
2. `static/js/puzzle.js` - Integrate Stockfish engine and evaluation logic
3. `static/js/stockfish.js` - NEW: Chess engine (931KB)
4. `FRONTEND.md` - Document evaluation system and UI behavior
5. `BACKEND.md` - Document new API contract and win likelihood formula

## Testing Recommendations

1. **Basic Functionality:**
   - Load puzzle page and verify Stockfish initializes
   - Make correct moves and verify green feedback with win %
   - Make incorrect moves and verify red feedback with win % drop

2. **Edge Cases:**
   - Test with tactical positions (multiple good moves)
   - Test with simple positions (single best move)
   - Test with complex positions (evaluation takes longer)
   - Test mate-in-X positions

3. **Performance:**
   - Monitor evaluation time (should be 2-5 seconds at depth 15)
   - Check browser console for errors
   - Verify Web Worker doesn't block UI

4. **Hint System:**
   - Verify hints still work (highlight from-square)
   - Confirm hint doesn't reveal the only valid move anymore

## Migration Notes

**Backward Compatibility:**
- Old puzzles with `correct_san` still work
- Stored correct move used for hints only
- No database migration needed
- Tests may need updating to send centipawn values instead of SAN

**Breaking Changes:**
- `/check_puzzle` API changed (requires `initial_cp`, `move_cp` instead of `san`)
- Frontend now requires JavaScript enabled (for Stockfish)
- Clients must evaluate positions before submitting

## Future Enhancements

1. **Adjustable Threshold:** Allow users to set strictness (5%, 10%, 15%)
2. **Show Multiple Solutions:** Display all moves within threshold
3. **Evaluation Depth Setting:** Let advanced users choose depth
4. **Comparison Mode:** Show evaluation of correct move vs user's move
5. **Opening Book:** Skip engine evaluation for common openings

## Rollback Plan

If issues arise:
```bash
git checkout main
git branch -D feature/stockfish-evaluation
```

To restore old behavior:
1. Revert `/check_puzzle` to accept `san` parameter
2. Remove Stockfish initialization from `puzzle.js`
3. Restore old `sendMoveToServer` function
4. Remove `static/js/stockfish.js`

## Resources

- Stockfish.js: https://github.com/lichess-org/stockfish.js
- Win likelihood formula: Based on chess.com evaluation bar
- Engine depth reference: https://www.chessprogramming.org/Depth
