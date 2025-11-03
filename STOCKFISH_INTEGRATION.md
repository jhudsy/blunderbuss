# Stockfish Integration - Evaluation-Based Move Validation

## Overview

This branch (`feature/stockfish-evaluation`) introduces a major change to how puzzle moves are validated in Blunderbuss. Instead of requiring an exact match to a predetermined correct move (SAN comparison), the system now uses Stockfish chess engine to evaluate positions and accepts any move that maintains the win likelihood within a 1% threshold.

## Key Changes

### 1. Move Validation Formula

**Win Likelihood Calculation:**
```javascript
win_likelihood = 50 + 50 * (2 / (e^(-0.00368 * cp) + 1) - 1)
```

Where `cp` is the centipawn evaluation from Stockfish.

**Correctness Criterion:**
A move is correct if: `(move_win - initial_win) >= -1.0`

This means the win chance cannot decrease by more than 1 percentage point.

### 2. Technical Implementation

**Frontend (static/js/puzzle.js):**

The evaluation system uses a two-phase approach for optimal performance:

**Phase 1: Precomputation (runs immediately when puzzle loads)**
1. Start Stockfish analysis of starting position (5000ms movetime)
2. Engine returns best move UCI and its CP evaluation
3. Cache both values: `{ bestMoveUci: "e2e4", bestMoveCp: 168 }`
4. This runs in background while player thinks

**Phase 2: Move Validation (when player makes a move)**

*Case A: Player plays the precomputed best move*
- Use cached CP value instantly
- Zero evaluation delay
- Send `(bestMoveCp, bestMoveCp)` to server

*Case B: Player plays a different move*
1. Use cached `bestMoveCp` (no re-evaluation needed)
2. Evaluate player's move from starting position using `searchmoves <playerMoveUci>`
3. This restricts engine to analyze only the player's move
4. Single 850ms evaluation for fair comparison
5. Send `(bestMoveCp, playerMoveCp)` to server

**Why searchmoves is Critical:**
Using `searchmoves` parameter ensures fair comparison:
- Both evaluations are from the **same starting position**
- Both evaluations reach the **same search depth**
- Engine returns CP from **current player's perspective** (after making the move)
- No need for board manipulation or perspective conversion
- Direct comparison: `delta_cp = playerMoveCp - bestMoveCp`

**Example:**
```
Starting position: white to move
Best move: e2e4, CP = +168 (white's advantage)
Player move: h2h3, CP = +158 (white's advantage)
Delta: +158 - +168 = -10 CP (player's move is 0.10 pawns worse)
Win% change: 65.81% - 64.98% = +0.83% (barely maintaining position)
```

**Backend (backend.py):**
- Modified `/check_puzzle` endpoint:
  - Accepts: `initial_cp`, `move_cp` (both from same starting position)
  - Calculates win likelihoods server-side (validation)
  - Returns evaluation details in response
  - No longer compares SAN strings

**Stockfish Engine:**
- Engine: Stockfish 17.1 (Lite and Full versions available)
- Files: `static/vendor/stockfish/stockfish-17.1-lite-*.js` and `.wasm`
- Runs in dedicated Web Worker (non-blocking UI)
- Configuration: 2 threads via UCI `setoption`
- Precomputation: 5000ms movetime (long for accurate best move)
- Player move: 850ms movetime (fast for responsiveness)
- Fallback: depth 7 search if movetime returns no CP
- Timeout handling: 1000ms timeout with `stop` command to force bestmove
- Visual feedback: Bootstrap spinner during evaluation
- Buttons disabled during analysis to prevent conflicts
- Engine selection: User can switch between Lite (faster) and Full (stronger)

### 3. User Experience Changes

**Correct Move Feedback:**
```
[Precompute phase during puzzle load]
[SF][precompute] info { depth: 20, score: "1.68", pv: "e2e4" }
[SF][precompute] bestmove { uci: "e2e4", cp: 168, pawns: "1.68" }

[Player makes best move - instant feedback]
[SF][eval] played best move; using precomputed CP
Correct! Click Next to continue.
```

**Incorrect Move Feedback:**
```
[Player makes different move]
[Spinner] Analyzing position...  (850ms evaluation)
[SF][eval] summary {
  best: { uci: "e2e4", san: "e4", cp: 168, cached: true },
  played: { uci: "h2h3", san: "h3", cp: 158 },
  delta_cp: -10,
  win_change_pct: "+0.83"
}
Incorrect. Win change: +0.83%. You have 2 attempts remaining.
The best move was e4.
```

**Engine Loading:**
- Loading spinner appears while WASM downloads (~2-3 seconds)
- "Loading chess engine..." message shown
- Error message if engine fails within 5 seconds
- Crossorigin isolation headers required (COOP/COEP/CORP)
- Dev server includes headers for localhost/127.0.0.1
- Production requires proper nginx/server configuration

**Hint System:**
- Still highlights the from-square of the precomputed best move
- Users can choose alternative moves if they maintain position
- Provides guidance without requiring exact move match
- Hint usage caps XP at minimum value (1 XP)

### 4. Benefits

1. **Multiple Valid Moves:** Accepts any reasonable move, not just the one from PGN analysis
2. **Better Learning:** Users understand *why* their move is wrong (win % drop)
3. **Flexible Puzzles:** Same puzzle can have multiple solutions
4. **Realistic Analysis:** Uses same engine (Stockfish) as lichess analysis

## Files Modified

1. `backend.py` - Update `/check_puzzle` endpoint for evaluation-based validation; add COOP/COEP/CORP headers for dev
2. `static/js/puzzle.js` - Integrate Stockfish engine, precomputation, and evaluation logic with searchmoves
3. `static/vendor/stockfish/` - NEW: Chess engine files (WASM + JS glue)
   - `stockfish-17.1-lite-51f59da.js` and `.wasm` (Lite version)
   - `stockfish-17.1-8e4d048.js` and multiple `.wasm` shards (Full version)
4. `templates/puzzle.html` - Script versioning for cache busting
5. `FRONTEND.md` - Document evaluation system and UI behavior
6. `BACKEND.md` - Document new API contract and win likelihood formula
7. `STOCKFISH_INTEGRATION.md` - This document (implementation details)

## Testing Recommendations

1. **Basic Functionality:**
   - Load puzzle page and verify Stockfish initializes (watch console for [SF] logs)
   - Check Network tab: WASM loads with `application/wasm` content-type
   - Make correct moves and verify instant feedback (uses precomputed CP)
   - Make incorrect moves and verify 850ms evaluation with spinner
   - Verify crossOriginIsolated is true (check console on load)

2. **Edge Cases:**
   - Move before precomputation finishes (should use partial/interrupted result)
   - Test with tactical positions (multiple good moves)
   - Test with simple positions (single best move)
   - Test with complex positions (evaluation takes longer)
   - Test mate-in-X positions
   - Test engine switch (Lite ↔ Full) during puzzle

3. **Performance:**
   - Precomputation: ~5-6 seconds in background (doesn't block UI)
   - Best move played: instant (0ms, uses cache)
   - Different move: ~850ms evaluation
   - Verify spinner appears and disappears correctly
   - Check browser console for [SF][precompute] and [SF][eval] logs
   - Verify Web Worker doesn't block UI
   - Test button disabling during evaluation

4. **Hint System:**
   - Verify hints still work (highlight from-square)
   - Confirm hint doesn't reveal the only valid move anymore
   - Check that hint usage caps XP at 1

5. **Debug Mode:**
   - Visit `/puzzle?debug=1` to enable debug logging
   - Console should show detailed evaluation summaries
   - Check `window.__cp_lastEval` for last evaluation details
   - Verify PV lines logged during precomputation

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
2. **Show Multiple Solutions:** Display all moves within threshold after puzzle completion
3. **Adjustable Time Constraint:** Let advanced users choose evaluation time (500ms, 1000ms, 2000ms)
4. **Comparison Mode:** Show evaluation of correct move vs user's move side-by-side
5. **Opening Book:** Skip engine evaluation for common openings (performance optimization)
6. **Evaluation Display:** Show real-time depth/score during precomputation
7. **Multi-PV Mode:** Show top 3 moves during precomputation for learning
8. **Engine Options:** Allow users to configure threads, hash size
9. **Analysis Board:** Post-puzzle review showing full engine analysis
10. **Evaluation Graph:** Visual bar showing win likelihood like lichess/chess.com

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
4. Remove `static/vendor/stockfish/` directory
5. Remove COOP/COEP/CORP headers from backend

## Implementation Details

### Evaluation Flow Diagram
```
[Puzzle Loads]
    ↓
[Start Precomputation] (5000ms, background)
    ├─ Find best move UCI
    ├─ Get CP for best move
    └─ Cache: { bestMoveUci, bestMoveCp }
    ↓
[Player Makes Move]
    ↓
    ├─ [Best move?] ─── YES ──→ Use cached CP (instant)
    │                              ↓
    └─ NO ──→ Evaluate with searchmoves (850ms)
                              ↓
                        Compare CPs
                              ↓
                        Send to server
                              ↓
                    [Server validates win%]
```

### Key Constants
```javascript
EVALUATION_TIMEOUT_MS = 1000              // Timeout for eval
EVALUATION_MOVETIME_MS = 850              // Player move eval time
EVALUATION_MOVETIME_PRECOMPUTE_MS = 5000  // Precompute time
EVALUATION_MIN_MOVETIME_MS = 850          // Min time before interrupt
EVALUATION_FALLBACK_DEPTH = 7             // Fallback depth search
STOCKFISH_THREADS = 2                     // UCI threads option
CORRECTNESS_THRESHOLD = -1.0              // Max win% drop allowed
```

### searchmoves Behavior
When using `go movetime 850 searchmoves e2e4`:
- Engine only considers the move `e2e4`
- Still searches to the same depth as unrestricted search
- Returns CP from current player's perspective
- CP represents advantage **after making the move**
- Directly comparable to unrestricted search results

### Cache Management
```javascript
preEvalCache = {
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  bestMoveUci: "e2e4",
  bestMoveCp: 25,
  inFlight: Promise<...>,  // null when complete
  startTime: 1699000000000,
  canInterrupt: true       // true after min time elapsed
}
```

### Error Handling
1. **Engine fails to load**: Show error, allow retry
2. **Evaluation timeout**: Send `stop`, trigger fallback
3. **No CP returned**: Fallback to depth search
4. **Fallback fails**: Reject with error, reset board
5. **Network error**: Show error, allow retry

## Resources

- Stockfish.js: https://github.com/lichess-org/stockfish.js
- Stockfish 17.1: https://stockfishchess.org/blog/2024/stockfish-17-1/
- Win likelihood formula: Based on chess.com evaluation bar
- Engine depth reference: https://www.chessprogramming.org/Depth
- UCI protocol: https://www.chessprogramming.org/UCI
- searchmoves parameter: https://www.chessprogramming.org/UCI#go
- SharedArrayBuffer/COOP: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer
- WebAssembly: https://developer.mozilla.org/en-US/docs/WebAssembly

## Debugging Tips

**Enable debug logging:**
```javascript
// Visit /puzzle?debug=1
// Or set cookie manually:
document.cookie = "cp_debug=1; path=/; max-age=31536000"
```

**Check engine status:**
```javascript
// In browser console:
window.crossOriginIsolated  // Should be true
window.__CP_DEBUG           // Should be true if debug enabled
window.__cp_lastEval        // Last evaluation details
```

**Console log patterns:**
```
[SF] initStockfish(): creating worker { choice: 'lite', ... }
[SF] onmessage: uciok (engine ready)
[SF][precompute] info { depth: 20, score: "1.68", pv: "e2e4" }
[SF][precompute] bestmove { uci: "e2e4", cp: 168, pawns: "1.68" }
[SF][eval] played best move; using precomputed CP
[SF][eval] summary { best: {...}, played: {...}, delta_cp: -10, ... }
```

**Common issues:**
1. **crossOriginIsolated = false**: Missing COOP/COEP headers
2. **WASM not loading**: Check content-type is `application/wasm`
3. **Worker errors**: Check browser console and Network tab
4. **Slow evaluation**: Try Lite engine or reduce movetime
5. **CP always equal**: searchmoves not working, check console logs
