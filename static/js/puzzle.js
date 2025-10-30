// Ensure CP_DEBUG exists and silence debug logs in production UI
if (typeof window !== 'undefined') {
  if (typeof window.__CP_DEBUG === 'undefined') window.__CP_DEBUG = false
  if (!window.__CP_DEBUG) { 
    try { console.debug = function(){} } catch(e){ /* Intentionally ignore */ } 
  }
}

// ============================================================================
// Global State
// ============================================================================

let board = null
let game = new Chess()
let currentPuzzle = null
let hintUsedForCurrent = false
let allowMoves = true
// Temporary state used to trigger a small castling rook animation on snap end
let __castlingPending = null
// result modal removed; use inline UI feedback instead

// Click-to-move state
let selectedSquare = null  // Currently selected piece square

// Stockfish engine state
let stockfishWorker = null
let stockfishReady = false
let evaluationInProgress = false
let currentEvaluationCallback = null
let evaluationTimeout = null

// ============================================================================
// Stockfish Engine Functions
// ============================================================================

/**
 * Initialize the Stockfish engine
 */
function initStockfish() {
  try {
    // stockfish.js from lichess-org is self-contained worker code with its own onmessage handler
    // We instantiate it directly as a Worker rather than importing it
    const baseUrl = window.location.origin;
    stockfishWorker = new Worker(baseUrl + '/static/js/stockfish.js');
    
    stockfishWorker.onmessage = function(e) {
      const message = e.data;
      
      // Handle error messages
      if (typeof message === 'string' && message.startsWith('ERROR:')) {
        logError('Stockfish error:', message);
        stockfishReady = false;
        showEngineError('Chess engine failed. Puzzle validation may not work correctly.');
        return;
      }
      
      if (message === 'uciok') {
        stockfishReady = true;
        hideEngineError();
        // Try to configure the engine to use 2 threads (if supported by this build)
        try { stockfishWorker.postMessage('setoption name Threads value 2') } catch(e) { /* ignored */ }
        if (window.__CP_DEBUG) console.debug('Stockfish engine ready (Threads=2 requested)');
      } else if (message.startsWith('info') && currentEvaluationCallback) {
        // Parse centipawn score from info messages
        const cpMatch = message.match(/score cp (-?\d+)/);
        const mateMatch = message.match(/score mate (-?\d+)/);
        const depthMatch = message.match(/depth (\d+)/);
        
        // Accept any depth result for fast response (movetime mode)
        if (depthMatch) {
          if (cpMatch) {
            const cp = parseInt(cpMatch[1]);
            // Update result for this depth
            currentEvaluationCallback.latestCp = cp;
          } else if (mateMatch) {
            const mateIn = parseInt(mateMatch[1]);
            // Convert mate scores to very high/low centipawn values
            // Positive mate: very good for current side, negative: very bad
            currentEvaluationCallback.latestCp = mateIn > 0 ? 10000 : -10000;
          }
        }
      } else if (message.startsWith('bestmove') && currentEvaluationCallback) {
        // Evaluation complete
        clearTimeout(evaluationTimeout);
        const callback = currentEvaluationCallback;
        currentEvaluationCallback = null;
        evaluationInProgress = false;
        
        if (callback.latestCp !== null) {
          callback.resolve(callback.latestCp);
        } else {
          // Sometimes movetime returns bestmove without info lines (simple positions)
          // If this is already a fallback attempt, the engine is not working properly
          if (callback.isFallback) {
            if (window.__CP_DEBUG) console.debug('Fallback depth search also had no cp - engine failure');
            callback.reject(new Error('Chess engine failed to evaluate position'));
            return;
          }
          
          // Fall back to a quick depth search to ensure we get a score
          if (window.__CP_DEBUG) console.debug('No cp from movetime, retrying with depth 5');
          
          // Set up for fallback evaluation
          evaluationInProgress = true;
          currentEvaluationCallback = {
            resolve: callback.resolve,
            reject: callback.reject,
            latestCp: null,
            fen: callback.fen,
            isFallback: true
          };
          
          // Use a shallow depth for quick fallback
          try {
            stockfishWorker.postMessage('position fen ' + callback.fen);
            stockfishWorker.postMessage('go depth 5');
          } catch(e) {
            // If we can't even send the command, engine has failed
            evaluationInProgress = false;
            currentEvaluationCallback = null;
            if (window.__CP_DEBUG) console.debug('Fallback command failed - engine error');
            callback.reject(new Error('Chess engine failed to evaluate position'));
          }
        }
      }
    };
    
    stockfishWorker.onerror = function(error) {
      logError('Stockfish worker error:', error);
      stockfishReady = false;
      showEngineError('Chess engine encountered an error. Please refresh the page.');
    };
    
    // Initialize UCI protocol with timeout
    stockfishWorker.postMessage('uci');
    
    // If engine doesn't respond within 5 seconds, show error
    setTimeout(() => {
      if (!stockfishReady) {
        showEngineError('Chess engine is taking longer than expected to load. Puzzle validation may not work correctly.');
      }
    }, 5000);
    
  } catch(e) {
    logError('Failed to initialize Stockfish:', e);
    stockfishReady = false;
    showEngineError('Failed to initialize chess engine. Please refresh the page.');
  }
}

/**
 * Show engine error message to user
 */
function showEngineError(message) {
  const infoEl = document.getElementById('info');
  if (infoEl) {
    infoEl.textContent = message;
    infoEl.style.color = '#dc3545'; // Bootstrap danger color
  }
}

/**
 * Hide engine error message
 */
function hideEngineError() {
  const infoEl = document.getElementById('info');
  if (infoEl && infoEl.style.color === 'rgb(220, 53, 69)') {
    infoEl.style.color = '';
  }
}

/**
 * Show spinner during evaluation
 */
function showEvaluatingSpinner() {
  const infoEl = document.getElementById('info');
  if (infoEl) {
    // Create spinner element if it doesn't exist
    let spinner = document.getElementById('evaluation-spinner');
    if (!spinner) {
      spinner = document.createElement('span');
      spinner.id = 'evaluation-spinner';
      spinner.className = 'spinner-border spinner-border-sm me-2';
      spinner.setAttribute('role', 'status');
      spinner.setAttribute('aria-hidden', 'true');
    }
    // Insert spinner at the beginning of info text
    if (infoEl.firstChild) {
      infoEl.insertBefore(spinner, infoEl.firstChild);
    } else {
      infoEl.appendChild(spinner);
    }
  }
}

/**
 * Hide evaluation spinner
 */
function hideEvaluatingSpinner() {
  const spinner = document.getElementById('evaluation-spinner');
  if (spinner && spinner.parentNode) {
    spinner.parentNode.removeChild(spinner);
  }
}

/**
 * Evaluate a FEN position using Stockfish
 * @param {string} fen - The FEN position to evaluate
 * @returns {Promise<number>} - The centipawn evaluation
 */
function evaluatePosition(fen) {
  return new Promise((resolve, reject) => {
    if (!stockfishReady) {
      reject(new Error('Stockfish not ready'));
      return;
    }
    
    if (evaluationInProgress) {
      reject(new Error('Evaluation already in progress'));
      return;
    }
    
    evaluationInProgress = true;
    currentEvaluationCallback = {
      resolve: resolve,
      reject: reject,
      latestCp: null,
      fen: fen
    };
    
  // Set timeout for evaluation - allow a bit over movetime to receive bestmove
    evaluationTimeout = setTimeout(() => {
      if (currentEvaluationCallback) {
        const callback = currentEvaluationCallback;
        currentEvaluationCallback = null;
        evaluationInProgress = false;
        // If we have any evaluation, use it
        if (callback.latestCp !== null) {
          callback.resolve(callback.latestCp);
        } else {
          // Timeout without evaluation
          // If this was a fallback attempt, it's a real engine failure
          if (callback.isFallback) {
            if (window.__CP_DEBUG) console.debug('Fallback evaluation timeout - engine failure');
            callback.reject(new Error('Chess engine failed to evaluate position'));
          } else {
            // Primary evaluation timeout - this shouldn't happen but use neutral 0
            // The bestmove handler will trigger a fallback if needed
            if (window.__CP_DEBUG) console.debug('Primary evaluation timeout, using neutral 0');
            callback.resolve(0);
          }
        }
      }
  }, 1000); // keep overall timeout at 1000ms; engine movetime is set to 600ms
    
    // Send position and request evaluation with a fixed movetime budget
    // Using movetime here allows a modest +100ms increase over earlier 500ms
    stockfishWorker.postMessage('ucinewgame');
    stockfishWorker.postMessage('position fen ' + fen);
    // Request 600ms of thinking time; we continue capturing the latest cp from info lines
    stockfishWorker.postMessage('go movetime 600');
  });
}

/**
 * Calculate win likelihood from centipawn evaluation
 * Formula: 50 + 50 * (2 / (e^(-0.00368*cp) + 1) - 1)
 * @param {number} cp - Centipawn evaluation
 * @returns {number} - Win probability as percentage (0-100)
 */
function winLikelihood(cp) {
  return 50 + 50 * (2 / (Math.exp(-0.00368 * cp) + 1) - 1);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Safe error logger - only logs in debug mode
 */
function logError(message, error) {
  if (window.__CP_DEBUG) {
    console.error(message, error)
  }
}

/**
 * Safe getElementById with null check
 */
function getElement(id) {
  try {
    return document.getElementById(id)
  } catch(e) {
    logError('Failed to get element:', e)
    return null
  }
}

/**
 * Set element display style safely
 */
function setElementDisplay(elementId, display) {
  const element = getElement(elementId)
  if (element) {
    try {
      element.style.display = display
    } catch(e) {
      logError(`Failed to set display for ${elementId}:`, e)
    }
  }
}

/**
 * Send a move to the server for validation
 */
async function sendMoveToServer(initialFen, moveFen, initialCp, moveCp) {
  try {
    const response = await fetch('/check_puzzle', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        id: currentPuzzle.id,
        initial_fen: initialFen,
        move_fen: moveFen,
        initial_cp: initialCp,
        move_cp: moveCp,
        hint_used: hintUsedForCurrent
      })
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '<no-body>')
      console.error('check_puzzle: non-OK response', response.status, text)
      throw new Error(`check_puzzle non-OK: ${response.status}`)
    }

    const json = await response.json().catch(e => {
      console.error('check_puzzle: JSON parse error', e)
      throw e
    })

    return json
  } catch(err) {
    console.error('check_puzzle: async error', err)
    throw err
  }
}

// ============================================================================
// UI Helper Functions
// ============================================================================

/**
 * Enable or disable the Next button with optional delay
 */
function setNextButtonEnabled(enabled, delay = 0) {
  const action = () => {
    const btn = getElement('next')
    if (btn) btn.disabled = !enabled
  }
  if (delay > 0) setTimeout(action, delay)
  else action()
}

/**
 * Enable or disable the Hint button
 */
function setHintButtonEnabled(enabled) {
  const btn = getElement('hint')
  if (btn) btn.disabled = !enabled
}

/**
 * Update the ribbon XP display and animate if increased
 */
function updateRibbonXP(newXP) {
  if (typeof newXP === 'undefined') return
  
  const rx = getElement('ribbonXP')
  if (rx) {
    const prev = parseInt(rx.textContent) || 0
    rx.textContent = newXP
    const delta = (newXP || 0) - prev
    if (delta > 0) animateXpIncrement(delta)
  }
}

/**
 * Refresh the ribbon state from the server
 */
function refreshRibbonState() {
  if (window.refreshRibbon) {
    try {
      window.refreshRibbon()
    } catch(e) {
      logError('Failed to refresh ribbon:', e)
    }
  }
}

/**
 * Reset the chess board to a given FEN position
 */
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
  // Clear any pending castling animation when resetting board
  __castlingPending = null
}

/**
 * Update all UI elements after receiving an answer
 */
function updateUIAfterAnswer(options = {}) {
  const {
    xp,
    enableNext = false,
    enableHint = false,
    nextDelay = 800,
    showBadges = null,
    showRecordStreak = null,
    showLichessLink = false
  } = options;
  
  if (xp !== undefined) updateRibbonXP(xp);
  refreshRibbonState();
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
  
  if (showLichessLink) {
    try { showSeeOnLichessLink(currentPuzzle); } catch(e) {}
  }
}

// ============================================================================
// Main Functions
// ============================================================================

async function loadPuzzle(){
  const res = await fetch('/get_puzzle')
  if (res.status === 401){
    // If the user is not logged in, show a simple prompt and hide controls instead
    const infoEl = document.getElementById('info')
    if (infoEl) infoEl.textContent = 'Please log in to practice puzzles.'
    try{ const nextBtn = document.getElementById('next'); if (nextBtn) nextBtn.style.display = 'none' } catch(e){}
    try{ const boardEl = document.getElementById('board'); if (boardEl) boardEl.style.display = 'none' } catch(e){}
    return
  }
  const data = await res.json()
  if (!res.ok){
    const infoEl = document.getElementById('info')
    const err = data.error || 'Failed to load puzzle'
    // treat 'user not found' as a signal to prompt for login rather than show a technical message
    if (res.status === 401 || err.toLowerCase().includes('not logged in') || err.toLowerCase().includes('user not found')){
      if (infoEl) infoEl.textContent = 'Please log in to practice puzzles.'
      try{ const nextBtn = document.getElementById('next'); if (nextBtn) nextBtn.style.display = 'none' } catch(e){}
      try{ const boardEl = document.getElementById('board'); if (boardEl) boardEl.style.display = 'none' } catch(e){}
    } else {
      if (infoEl) infoEl.textContent = err
    }
    return
  }
  currentPuzzle = data
  // Remove any leftover 'See on lichess' link from a previous puzzle. If
  // the newly loaded puzzle has game info, showSeeOnLichessLink() will
  // recreate the link as needed; otherwise removing avoids a stale button.
  try{
    const old = document.getElementById('seeOnLichessContainer')
    if (old && old.parentNode) old.parentNode.removeChild(old)
  }catch(e){}
  // clear any square highlights from previous puzzle
  clearAllHighlights()
  
  // Reset click-to-move state
  clearClickToMoveSelection()
  
  // Clear any pending castling animation from previous puzzle
  __castlingPending = null

  game = new Chess()
  game.load(currentPuzzle.fen)
  board.position(currentPuzzle.fen)
  // flip board orientation if it's black to move in the FEN
  try{
    const turn = game.turn()
    if (turn === 'b') board.orientation('black')
    else board.orientation('white')
  } catch(e){ /* ignore */ }

  // populate metadata if available
  const metaEl = document.getElementById('puzzleMeta')
  if (metaEl){
    // Helper: escape HTML to avoid injection when using innerHTML
    const esc = (s) => String(s || '').replace(/[&<>"']/g, function(m){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"})[m] })
    // Format time control like "300+0" -> "5:00+0s" or "45+5" -> "45+5s" or "3661+2" -> "1:01:01+2s"
    const formatTimeControl = (tc) => {
      if (!tc) return ''
      try{
        const parts = String(tc).split('+')
        const base = parseInt(parts[0], 10)
        const inc = parts.length > 1 ? parseInt(parts[1], 10) : 0
        if (!isFinite(base) || base < 0) return String(tc)
        let hrs = Math.floor(base / 3600)
        let mins = Math.floor((base % 3600) / 60)
        let secs = base % 60
        let baseStr = ''
        if (hrs > 0){
          // H:MM:SS
          baseStr = `${hrs}:${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`
        } else if (mins > 0){
          // M:SS
          baseStr = `${mins}:${String(secs).padStart(2,'0')}`
        } else {
          // seconds only
          baseStr = `${secs}`
        }
        const incStr = isFinite(inc) ? `+${inc}s` : ''
        return baseStr + incStr
      }catch(e){ return String(tc) }
    }

    const rows = []
    if (currentPuzzle.white) rows.push(`<div><strong>White:</strong> ${esc(currentPuzzle.white)}</div>`)
    if (currentPuzzle.black) rows.push(`<div><strong>Black:</strong> ${esc(currentPuzzle.black)}</div>`)
    if (currentPuzzle.date) rows.push(`<div><strong>Date:</strong> ${esc(currentPuzzle.date)}</div>`)
    if (currentPuzzle.time_control) rows.push(`<div><strong>Time Control:</strong> ${esc(formatTimeControl(currentPuzzle.time_control))}</div>`)
    // If no metadata found, clear the element
    if (!rows.length) metaEl.textContent = ''
    else metaEl.innerHTML = rows.join('')
  }

  document.getElementById('info').textContent = 'Make the correct move.'
  // hide any previously revealed correct move
  const cmc = document.getElementById('correctMoveContainer')
  if (cmc) { cmc.style.display = 'none'; document.getElementById('correctMoveText').textContent = '' }
  
  // Ensure Next is disabled until the puzzle is answered
  setNextButtonEnabled(false);
  
  // Reset hint state
  hintUsedForCurrent = false
  
  // Allow moves for the newly loaded puzzle
  allowMoves = true
  
  try{
    const hintBtn = document.getElementById('hint')
    const nextBtn = document.getElementById('next')
    if (hintBtn){
      // Mirror Next button styling so the buttons look consistent
      if (nextBtn) hintBtn.className = nextBtn.className
      hintBtn.disabled = false
    }
  } catch(e){}
  
  // Refresh ribbon XP/streak for this user
  refreshRibbonState();
}

/**
 * Handle the response from /check_puzzle endpoint
 * @param {object} j - JSON response from server
 * @param {string} source - Source square (e.g. 'e2')
 * @param {string} target - Target square (e.g. 'e4')
 * @param {string} startFEN - FEN string of the position before the move
 */
function handleCheckPuzzleResponse(j, source, target, startFEN, clientEval) {
  // Check if max attempts reached before locking board
  const maxAttemptsReached = j.max_attempts_reached || false
  const attemptsRemaining = j.attempts_remaining || 0
  const hasAttemptsLeft = !j.correct && !maxAttemptsReached && attemptsRemaining > 0
  
  // Resolve CP values, falling back to client-evaluated numbers if server omits them
  const resolvedInitialCp = (typeof j.initial_cp === 'number') ? j.initial_cp : (clientEval && typeof clientEval.initialCp === 'number' ? clientEval.initialCp : null)
  const resolvedMoveCp = (typeof j.move_cp === 'number') ? j.move_cp : (clientEval && typeof clientEval.moveCp === 'number' ? clientEval.moveCp : null)

  // Log evaluation details for debugging
  if (window.__CP_DEBUG) {
    console.debug('Evaluation result:', {
      initial_cp: resolvedInitialCp,
      move_cp: resolvedMoveCp,
      initial_win: j.initial_win,
      move_win: j.move_win,
      win_change: j.win_change,
      correct: j.correct
    });
  }
  
  // Only lock board interactions if answer is correct OR max attempts reached
  if (!hasAttemptsLeft) {
    allowMoves = false
  }
  
  if (j.correct) {
    // Handle correct answer
    highlightSquareWithFade(source, 'green')
    highlightSquareWithFade(target, 'green')
    
    const infoEl = document.getElementById('info')
    if (infoEl) {
      // Format centipawn values (convert to pawn units: 100 cp = 1.0 pawns)
      const initialPawns = (resolvedInitialCp != null) ? (resolvedInitialCp / 100).toFixed(1) : '—'
      const movePawns = (resolvedMoveCp != null) ? (resolvedMoveCp / 100).toFixed(1) : '—'
      // Show evaluation details with centipawn notation
      infoEl.textContent = `Correct! Evaluation: ${initialPawns} → ${movePawns}. Win chance: ${j.initial_win}% → ${j.move_win}% (${j.win_change >= 0 ? '+' : ''}${j.win_change}%). Click Next to continue.`;
    }
    
    // Update all UI elements
    updateUIAfterAnswer({
      xp: j.xp,
      enableNext: true,
      enableHint: false,
      nextDelay: 800,
      showBadges: j.awarded_badges,
      showRecordStreak: j.new_record_streak,
      showLichessLink: true
    });
    
  } else {
    // Handle incorrect answer
    highlightSquareWithFade(source, 'red')
    highlightSquareWithFade(target, 'red')
    
    // If attempts remain, allow another try
    if (!maxAttemptsReached && attemptsRemaining > 0) {
      const infoEl = document.getElementById('info');
      if (infoEl) {
        // Format centipawn values (convert to pawn units: 100 cp = 1.0 pawns)
        const initialPawns = (resolvedInitialCp != null) ? (resolvedInitialCp / 100).toFixed(1) : '—'
        const movePawns = (resolvedMoveCp != null) ? (resolvedMoveCp / 100).toFixed(1) : '—'
        infoEl.textContent = `Incorrect. Evaluation dropped: ${initialPawns} → ${movePawns}. Win chance: ${j.move_win}% (${j.win_change}%). You have ${attemptsRemaining} attempt${attemptsRemaining > 1 ? 's' : ''} remaining.`;
      }
      // Re-enable moves after a brief delay
      setTimeout(() => {
        resetBoard(startFEN);
        allowMoves = true;
        // Re-enable the Hint button for subsequent attempts
        setHintButtonEnabled(true);
      }, 1000);
      return;
    }

    // Max attempts reached - reveal solution and disable further moves
    // First show the evaluation for the last incorrect move
    const infoEl = document.getElementById('info');
    if (infoEl) {
      // Format centipawn values (convert to pawn units: 100 cp = 1.0 pawns)
      const initialPawns = (resolvedInitialCp != null) ? (resolvedInitialCp / 100).toFixed(1) : '—'
      const movePawns = (resolvedMoveCp != null) ? (resolvedMoveCp / 100).toFixed(1) : '—'
      infoEl.textContent = `Incorrect. Evaluation dropped: ${initialPawns} → ${movePawns}. Win chance: ${j.move_win}% (${j.win_change}%). Maximum attempts reached.`;
    }
    
    // Start reveal sequence using nested setTimeouts
    setTimeout(() => {
      // 1) Reset board to the starting position
      resetBoard(startFEN);

      // 2) Wait a little more before revealing the correct move
      setTimeout(() => {
        // 3) Reveal correct move if provided
        if (j.correct_san){
          const cmc = document.getElementById('correctMoveContainer')
          if (cmc) cmc.style.display = ''
          
          // Sanitize SAN from server
          let san = (j.correct_san || '').toString().trim()
          san = san.replace(/^\d+\.*\s*/, '')
          san = san.replace(/\.{2,}/g, '')
          san = san.replace(/[(),;:]/g, '')
          san = san.trim()
          
          try{
            // Compute the correct move from the starting position
            const temp = new Chess()
            try{ temp.load(startFEN) } catch(e){ /* ignore */ }
            const moveObj = temp.move(san, {sloppy: true})
            
            if (moveObj){
              try{ revealCorrectMoveSquares(moveObj.from, moveObj.to, moveObj.promotion, moveObj.flags, temp.fen()) } catch(e){}
            } else {
              // Fallback: scan moves list
              const moves = temp.moves({verbose:true})
              for (let m of moves){
                if (m.san === san){
                  if (window.__CP_DEBUG) console.debug('matched move in moves list:', m)
                  try{ revealCorrectMoveSquares(m.from, m.to, m.promotion, m.flags, temp.fen()) } catch(e){ board.position(startFEN) }
                  break
                }
              }
              if (window.__CP_DEBUG) console.debug('fallback scan complete, no direct temp.move result')
            }
            
            // Ensure the global game is reset back to the starting position after reveal
            try{ game.load(startFEN) } catch(e){ /* ignore */ }
          }catch(e){ /* ignore reveal failures */ }
        }
        
        // Show badges if any and update UI
        const infoEl2 = document.getElementById('info')
        if (infoEl2) {
          if (maxAttemptsReached) {
            infoEl2.textContent = 'Maximum attempts reached — the correct move is shown on the board. Click Next to continue.';
          } else {
            infoEl2.textContent = 'Incorrect — the correct move is shown on the board. Click Next to continue.';
          }
        }
        
        // Update all UI elements after incorrect answer
        updateUIAfterAnswer({
          xp: j.xp,
          enableNext: true,
          enableHint: false,
          nextDelay: 800,
          showBadges: j.awarded_badges,
          showLichessLink: true
        });
      }, 250)
    }, 800)
  }
}

  // import-related UI removed
async function onDrop(source, target){
  // guard: ensure we have a loaded puzzle
  // clear any lingering hint highlight immediately when attempting a move
  clearHintHighlights()
  
  if (!currentPuzzle){
    if (window.__CP_DEBUG) console.debug('onDrop called before puzzle loaded')
    return 'snapback'
  }

  const move = {from: source, to: target, promotion: 'q'}
  // capture the starting FEN so we can reset after a wrong move
  const startFEN = game.fen()
  
  // Helper: evaluate both positions and send to server
  async function evaluateAndSendMove(result, startFEN){
    try {
      // Disable buttons and show spinner
      setNextButtonEnabled(false);
      setHintButtonEnabled(false);
      showEvaluatingSpinner();
      
      const infoEl = document.getElementById('info');
      if (infoEl) infoEl.textContent = 'Analyzing position...';
      
      // Evaluate initial position
      const initialCp = await evaluatePosition(startFEN);
      
      // Evaluate position after move
      const moveFen = game.fen();
      const moveCp = await evaluatePosition(moveFen);
      
      // Hide spinner after evaluation completes
      hideEvaluatingSpinner();
      
      // IMPORTANT: Stockfish evaluates from the perspective of the side to move.
      // After the player's move, the evaluation is from the opponent's perspective,
      // so we must negate it to compare with the initial evaluation.
      const moveCpAdjusted = -moveCp;
      
      // Calculate win likelihoods
      const initialWin = winLikelihood(initialCp);
      const moveWin = winLikelihood(moveCpAdjusted);
      const winChange = moveWin - initialWin;
      
      if (window.__CP_DEBUG) {
        console.debug('Evaluation:', {
          startFEN,
          moveFen,
          initialCp,
          moveCp,
          moveCpAdjusted,
          initialWin: initialWin.toFixed(2) + '%',
          moveWin: moveWin.toFixed(2) + '%',
          winChange: winChange.toFixed(2) + '%'
        });
      }
      
  // Send to server (using adjusted moveCp)
  const json = await sendMoveToServer(startFEN, moveFen, initialCp, moveCpAdjusted);
  // Pass client-evaluated CPs to ensure UI can always show CP change
  handleCheckPuzzleResponse(json, source, target, startFEN, { initialCp, moveCp: moveCpAdjusted });
    } catch(err) {
      console.error('Evaluation or server error:', err);
      hideEvaluatingSpinner();
      const infoEl = document.getElementById('info');
      if (infoEl) {
        if (err.message && err.message.includes('not ready')) {
          infoEl.textContent = 'Chess engine not ready. Please wait a moment and try again.';
        } else if (err.message && err.message.includes('failed to evaluate')) {
          infoEl.textContent = 'Chess engine failed to analyze this position. Please try again or click Next for a different puzzle.';
        } else {
          infoEl.textContent = 'Error analyzing position. Please try again.';
        }
      }
      // Re-enable buttons and moves after error
      setHintButtonEnabled(true);
      setTimeout(() => {
        resetBoard(startFEN);
        allowMoves = true;
      }, 2000);
    }
  }

  // detect pawn promotion: if a pawn moves to the last rank, prompt the user
  try{
    const pieceObj = game.get(source)
    if (pieceObj && pieceObj.type === 'p'){
      const isWhite = pieceObj.color === 'w'
      const rank = target[1]
      if ((isWhite && rank === '8') || (!isWhite && rank === '1')){
        // present promotion selector, then perform the chosen promotion
        showPromotionSelector(source, target, async function(promo){
          if (!promo) return
          
          // attempt the move with the selected promotion
          const moveObj = { from: source, to: target, promotion: promo }
          const res = game.move(moveObj)
          
          if (res === null){
            // illegal promotion; restore board
            try { 
              board.position(startFEN) 
            } catch(e) {
              logError('Failed to restore board after illegal promotion:', e)
            }
            return
          }
          
          // update board to reflect the chosen promotion
          try { 
            board.position(game.fen()) 
          } catch(e) {
            logError('Failed to update board after promotion:', e)
          }
          
          // If this move is a castle, mark it so onSnapEnd can play a small rook animation
          if (res?.flags && (String(res.flags).includes('k') || String(res.flags).includes('q'))) {
            __castlingPending = { startFEN: startFEN, endFEN: game.fen(), move: res }
          }
          
          // lock moves and send to server and handle UI
          allowMoves = false
          await evaluateAndSendMove(res, startFEN)
        })
        return 'snapback'
      }
    }
  } catch(e) {
    logError('Promotion detection failed:', e)
  }

  const result = game.move(move)
  if (result === null){
    return 'snapback'
  }
  
  // lock moves and send to backend with evaluation
  allowMoves = false
  
  // if this move is a castle, mark pending animation for onSnapEnd
  if (result?.flags && (String(result.flags).includes('k') || String(result.flags).includes('q'))) {
    __castlingPending = { startFEN: startFEN, endFEN: game.fen(), move: result }
  }
  
  // Send move to server and handle response
  await evaluateAndSendMove(result, startFEN)
}

// Show a simple promotion selector overlay. Calls cb(piece) with one of 'q','r','b','n',
// or null if cancelled.
function showPromotionSelector(from, to, cb){
  try{
    // remove any existing selector
    const prev = document.getElementById('promotionSelector')
    if (prev) try{ prev.parentNode.removeChild(prev) }catch(e){}
    const overlay = document.createElement('div')
    overlay.id = 'promotionSelector'
    overlay.style.position = 'fixed'
    overlay.style.left = '0'
    overlay.style.top = '0'
    overlay.style.right = '0'
    overlay.style.bottom = '0'
    overlay.style.zIndex = '4000'
    overlay.style.background = 'rgba(0,0,0,0.45)'
    overlay.style.pointerEvents = 'auto'

    const box = document.createElement('div')
    box.style.position = 'absolute'
    box.style.background = '#fff'
    box.style.padding = '8px'
    box.style.borderRadius = '8px'
    box.style.display = 'flex'
    box.style.gap = '6px'
    box.style.boxShadow = '0 6px 18px rgba(0,0,0,0.2)'
    box.style.alignItems = 'center'

    // determine piece color from the moving pawn (default to white)
    let colorPrefix = 'w'
    try{ const p = game.get(from); if (p && p.color) colorPrefix = p.color }catch(e){}

    const pieces = ['q','r','b','n']
    for (let p of pieces){
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'btn btn-outline-primary'
      btn.style.display = 'flex'
      btn.style.alignItems = 'center'
      btn.style.justifyContent = 'center'
      btn.style.padding = '6px'

      const img = document.createElement('img')
      img.alt = p
      img.src = `/static/img/chesspieces/${colorPrefix}${p.toUpperCase()}.png`
      img.style.width = '36px'
      img.style.height = '36px'
      img.style.pointerEvents = 'none'
      btn.appendChild(img)

      btn.addEventListener('click', (e)=>{
        try{ overlay.parentNode && overlay.parentNode.removeChild(overlay) }catch(e){}
        try{ cb(p) }catch(e){}
      })
      box.appendChild(btn)
    }

    // cancel on backdrop click
    overlay.addEventListener('click', (e)=>{ if (e.target === overlay){ try{ overlay.parentNode && overlay.parentNode.removeChild(overlay) }catch(e){}; try{ cb(null) }catch(e){} } })
    overlay.appendChild(box)
    document.body.appendChild(overlay)

    // Position the box next to the promotion square if possible
    try{
      const sq = document.querySelector('.square-' + to)
      if (sq){
        const rect = sq.getBoundingClientRect()
        const padding = 8
        // approximate box width based on number of items
        const perBtn = 48
        const boxWidth = perBtn * pieces.length
        // prefer to the right of the square
        let left = rect.right + padding
        // if not enough room on right, place to left
        if (left + boxWidth > window.innerWidth - 10){
          left = rect.left - boxWidth - padding
        }
        // clamp
        if (left < 6) left = Math.max(6, rect.left)
        // try to align top with square; if near bottom, adjust
        let top = rect.top
        const estHeight = 56
        if (top + estHeight > window.innerHeight - 10) top = Math.max(6, window.innerHeight - estHeight - 10)
        box.style.left = left + 'px'
        box.style.top = top + 'px'
      } else {
        // fallback to centered
        box.style.left = '50%'
        box.style.top = '50%'
        box.style.transform = 'translate(-50%,-50%)'
      }
    }catch(e){ /* ignore positioning failures and keep centered fallback */ }
  }catch(e){ if (window.__CP_DEBUG) console.debug('showPromotionSelector failed', e); try{ cb(null) }catch(e){} }
}

// Display a simple congratulatory modal for new puzzle-streak records
// Show a small toast for new puzzle-streak records (uses same toast container as badges)
function showRecordToast(newBest){
  try{
    const container = document.getElementById('toastContainer')
    if (!container){
      // fallback to alert if no toast container present
      try{ alert('Congratulations! New record puzzle streak: ' + String(newBest)) }catch(e){}
      return
    }
    const toastEl = document.createElement('div')
    toastEl.className = 'toast'
    toastEl.setAttribute('role','alert')
    toastEl.setAttribute('aria-live','polite')
    toastEl.setAttribute('aria-atomic','true')
    toastEl.innerHTML = `
      <div class="toast-header">
        <strong class="me-auto">New record!</strong>
        <small class="text-muted">now</small>
        <button type="button" class="btn-close ms-2 mb-1" data-bs-dismiss="toast" aria-label="Close"></button>
      </div>
      <div class="toast-body">
        New record puzzle streak: <strong>${String(newBest)}</strong>
      </div>`
    container.appendChild(toastEl)
    const bs = new bootstrap.Toast(toastEl, { autohide: true, delay: 3000 })
    bs.show()
    toastEl.addEventListener('hidden.bs.toast', ()=>{ try{ container.removeChild(toastEl) }catch(e){} })
  }catch(e){ try{ alert('Congratulations! New record puzzle streak: ' + String(newBest)) }catch(e){} }
}

// remove only hint (blue) highlight classes
// NOTE: Does NOT clear click-to-move selection - that's managed separately
function clearHintHighlights(){
  try {
    const els = document.querySelectorAll('.square-highlight-blue')
    els.forEach(el => el.classList.remove('square-highlight-blue'))
  } catch(e) {
    logError('Failed to clear hint highlights:', e)
  }
}

// Clear click-to-move selection and purple highlight
function clearClickToMoveSelection(){
  if (!selectedSquare) return
  
  try {
    const boardEl = getElement('board')
    if (boardEl) {
      const el = boardEl.querySelector('.square-' + selectedSquare)
      if (el) {
        el.classList.remove('highlight1-32417')
      }
    }
    selectedSquare = null
  } catch(e) {
    logError('Failed to clear click-to-move selection:', e)
  }
}

// highlight a square (e.g., the square containing the piece to move) for a short duration
function hintHighlightSquare(square, durationMs){
  try{
    const el = document.querySelector('.square-' + square)
    if (!el) return
    // hints should use the blue highlight class
    el.classList.add('square-highlight-blue')
    setTimeout(()=>{ try{ el.classList.remove('square-highlight-blue') }catch(e){} }, durationMs || 2000)
  }catch(e){}
}

// attach hint button handler
window.addEventListener('DOMContentLoaded', ()=>{
  const hintBtn = document.getElementById('hint')
  if (hintBtn){
    hintBtn.addEventListener('click', async ()=>{
      try{
        if (!currentPuzzle) return
        // Ask the server for the hint (from-square) so we don't need to expose correct_san
        const r = await fetch('/puzzle_hint', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({id: currentPuzzle.id})})
        if (!r.ok){
          if (window.__CP_DEBUG) console.debug('puzzle_hint failed', r.status)
          return
        }
        const j = await r.json().catch(e=>null)
        if (!j || !j.from) return
  hintUsedForCurrent = true
  // keep the hint button enabled so the user can press it again to re-highlight
        hintHighlightSquare(j.from, 3000)
      }catch(e){ if (window.__CP_DEBUG) console.debug('Hint failed', e) }
    })
  }
})

function lichessGameIdFrom(s){
  if (!s) return null
  try{
    const url = new URL(s)
    const parts = url.pathname.replace(/^\//,'').split('/')
    return parts.length ? parts[0] : null
  }catch(e){
    // not a full URL; assume just an id or path
    const parts = String(s).split('/').filter(Boolean)
    return parts.length ? parts.pop() : s
  }
}

function showSeeOnLichessLink(puzzle){
  if (!puzzle) return
  // prefer game_url but fall back to game_id
  const raw = puzzle.game_url || puzzle.game_id
  const gameId = lichessGameIdFrom(raw)
  // puzzle.move_number is a full-move number (1..N). Lichess expects a
  // half-move (ply) index for the fragment. Convert: ply = (move_number-1)*2 + (white?1:2)
  const fullMove = parseInt(puzzle.move_number, 10)
  const side = (puzzle.side || 'white').toLowerCase()
  if (!isFinite(fullMove)) return
  const move = ((fullMove - 1) * 2) + (side === 'white' ? 1 : 2)
  if (!gameId || !move) return
  let container = document.getElementById('seeOnLichessContainer')
  if (!container){
    // try to place next to Next button
    const nextBtn = document.getElementById('next')
    if (!nextBtn) return
    container = document.createElement('span')
    container.id = 'seeOnLichessContainer'
    // avoid inline margins; rely on the parent's flex gap for spacing
    container.style.marginLeft = ''
    nextBtn.parentNode.insertBefore(container, nextBtn.nextSibling)
  }
  // create or update link
  let link = document.getElementById('seeOnLichess')
  const url = `https://lichess.org/${gameId}/${side}#${move}`
  if (!link){
    link = document.createElement('a')
    link.id = 'seeOnLichess'
    // Match the Next button's classes so the appearance is identical
    try{
      const nextBtn2 = document.getElementById('next')
      if (nextBtn2) link.className = nextBtn2.className
      else link.className = 'btn btn-primary mb-2'
    }catch(e){ link.className = 'btn btn-primary mb-2' }
    link.target = '_blank'
    link.rel = 'noopener'
    link.textContent = 'See on lichess'
    link.href = url
    container.appendChild(link)
  } else {
    link.href = url
  }
}

function highlightSquare(square, color){
  const el = document.querySelector('.square-' + square)
  if (el) el.style.background = color
}

// Show a bootstrap toast listing awarded badges
function showBadgeToast(badges){
  try{
    if (!badges || !badges.length) return
    const container = document.getElementById('toastContainer')
    if (!container) return
    const toastEl = document.createElement('div')
    toastEl.className = 'toast'
    toastEl.setAttribute('role','alert')
    toastEl.setAttribute('aria-live','assertive')
    toastEl.setAttribute('aria-atomic','true');
    // attempt to enrich badges with metadata from /api/badges
    (async ()=>{
      let items = badges.map(b=>({name: b}))
      try{
        const r = await fetch('/api/badges', { credentials: 'same-origin' })
        if (r.ok){
          const j = await r.json()
          const catalog = j.catalog || {}
          items = badges.map(b=>{
            const meta = (j.badges || []).find(x=>x.name === b) || {}
            const cat = catalog[b] || {}
            return { name: b, icon: meta.icon || cat.icon, description: meta.description || cat.description }
          })
        }
      }catch(e){ /* ignore enrichment failures */ }
      toastEl.innerHTML = `
        <div class="toast-header">
          <strong class="me-auto">Badges earned</strong>
          <small class="text-muted">now</small>
          <button type="button" class="btn-close ms-2 mb-1" data-bs-dismiss="toast" aria-label="Close"></button>
        </div>
        <div class="toast-body">
          <ul style="margin:0;padding-left:1.2em">${items.map(it=>`<li>${it.icon?`<img src="/static/img/badges/${it.icon}" alt="${it.name}" style="width:20px;height:20px;margin-right:6px;vertical-align:text-bottom">` : ''}<strong>${it.name}</strong>${it.description?` — <small class="text-muted">${it.description}</small>` : ''}</li>`).join('')}</ul>
        </div>`
      container.appendChild(toastEl)
      const bs = new bootstrap.Toast(toastEl, { autohide: true, delay: 3000 })
      bs.show()
      // remove after hidden
      toastEl.addEventListener('hidden.bs.toast', ()=>{ try{ container.removeChild(toastEl) }catch(e){} })
    })()
  }catch(e){ if (window.__CP_DEBUG) console.debug('showBadgeToast failed', e) }
}

// Show a small +XP animation near the ribbon XP element
function animateXpIncrement(delta){
  try{
    // only animate for meaningful gains
    if (!delta || delta < 5) return
    const xpEl = document.getElementById('ribbonXP')
    if (!xpEl) return
    const rect = xpEl.getBoundingClientRect()
    const el = document.createElement('div')
    el.textContent = `+${delta} XP`
    el.style.position = 'fixed'
    el.style.left = (rect.right - 10) + 'px'
    el.style.top = (rect.top - 6) + 'px'
    el.style.zIndex = 2000
    el.style.fontWeight = '600'
    el.style.color = '#28a745'
    el.style.transition = 'transform 900ms ease-out, opacity 900ms ease-out'
    el.style.transform = 'translateY(0px)'
    el.style.opacity = '1'
    document.body.appendChild(el)
    // force layout then animate up and fade
    requestAnimationFrame(()=>{
      el.style.transform = 'translateY(-30px)'
      el.style.opacity = '0'
    })
    // cleanup
    setTimeout(()=>{ try{ document.body.removeChild(el) }catch(e){} }, 1200)
  }catch(e){ /* ignore animation failures */ }
}

function clearAllHighlights(){
  // remove highlight classes and inline styles on all board squares
  const els = document.querySelectorAll('[class*="square-"]')
  els.forEach(el=>{ el.classList.remove('square-highlight-green','square-highlight-red','highlight1-32417'); el.style.background = '' })
}

function highlightSquareWithFade(square, color){
  const cls = color === 'green' ? 'square-highlight-green' : 'square-highlight-red'
  const el = document.querySelector('.square-' + square)
  if (!el) return
  // apply class (CSS handles opacity/transition)
  el.classList.add(cls)
  // remove after a delay; read duration from CSS variable --highlight-duration
  try{
    const root = getComputedStyle(document.documentElement).getPropertyValue('--highlight-duration') || '1.2s'
    // convert to milliseconds (support s or ms)
    let ms = 1200
    if (root.trim().endsWith('ms')) ms = parseFloat(root) || 1200
    else if (root.trim().endsWith('s')) ms = (parseFloat(root) || 1.2) * 1000
    setTimeout(()=>{ el.classList.remove(cls) }, ms)
  }catch(e){ setTimeout(()=>{ el.classList.remove(cls) }, 1200) }
}

// Reveal the correct move by highlighting the from/to squares with a pulsing animation
function revealCorrectMoveSquares(from, to, promotion, flags, finalFEN){
  try{
    // If this is a promotion move, we need to update the board position
    // to show the promoted piece, not just animate the pawn moving
    if (promotion) {
      // Get current position, make the move manually with promotion
      const currentPos = board.position()
      const piece = currentPos[from]
      if (piece) {
        // Remove piece from source square
        delete currentPos[from]
        // Add promoted piece to destination square
        // promotion is like 'q', 'r', 'n', 'b'
        const color = piece.charAt(0) // 'w' or 'b'
        currentPos[to] = color + promotion.toUpperCase()
        // Update board position to show the promotion
        board.position(currentPos, true) // true = animate
      }
    } else if (flags && (flags.includes('k') || flags.includes('q'))) {
      // Castling move: animate king first, then update board to show rook
      try { board.move(from + '-' + to) } catch(e) { /* ignore animation failure */ }
      // After king animation, update board to final position to show rook move
      if (finalFEN) {
        setTimeout(() => {
          try { board.position(finalFEN) } catch(e) { /* ignore */ }
        }, 200)
      }
    } else {
      // Normal move: animate using chessboard.js
      try { board.move(from + '-' + to) } catch(e) { /* ignore animation failure */ }
    }
    
    const fromEl = document.querySelector('.square-' + from)
    const toEl = document.querySelector('.square-' + to)
    // apply highlight classes if elements exist
    if (fromEl) fromEl.classList.add('square-highlight-green','square-reveal-anim')
    if (toEl) toEl.classList.add('square-highlight-green','square-reveal-anim')
    // compute duration from CSS var
    let ms = 1200
    try{
      const root = getComputedStyle(document.documentElement).getPropertyValue('--highlight-duration') || '1.2s'
      if (root.trim().endsWith('ms')) ms = parseFloat(root) || 1200
      else if (root.trim().endsWith('s')) ms = (parseFloat(root) || 1.2) * 1000
    }catch(e){ ms = 1200 }
    // remove highlight/animation classes after the duration (+ small buffer)
    setTimeout(()=>{
      if (fromEl) fromEl.classList.remove('square-reveal-anim','square-highlight-green')
      if (toEl) toEl.classList.remove('square-reveal-anim','square-highlight-green')
    }, ms + 200)
  }catch(e){ /* noop */ }
}

// (castling animations handled by chessboard.js via onSnapEnd)

// Variable to track if a drag is in progress (shared between onDragStart and click-to-move)
let isDragInProgress = false
let dragStartSquare = null // Track where drag started from

window.addEventListener('DOMContentLoaded', ()=>{
  // Initialize Stockfish engine
  initStockfish();
  
  // create the board once with our local pieceTheme
  // clear hint when user begins interacting with the board (onDragStart)
  
  board = Chessboard('board', {
    position: 'start',
    draggable: true,
    onDrop: async function(source, target) {
      // Check if this is a valid drop or a snapback
      const result = await onDrop(source, target)
      
      // Only clear dragStartSquare if the drop was accepted (not a snapback)
      if (result !== 'snapback') {
        dragStartSquare = null
      }
      
      return result
    },
    onDragStart: function(source, piece, position, orientation){
      // Respect allowMoves flag
      try{ clearHintHighlights() }catch(e){}
      try{
        if (!allowMoves) return false
        
        // Only allow picking up pieces for the side to move.
        if ((game.turn() === 'w' && piece.search(/^b/) !== -1) ||
            (game.turn() === 'b' && piece.search(/^w/) !== -1)) {
          return false
        }
        
        // Mark that a drag is now in progress and track where it started
        // (only after validating the piece can be dragged)
        isDragInProgress = true
        dragStartSquare = source
        
        // Clear any existing selection when starting a drag
        if (selectedSquare) {
          clearClickToMoveSelection()
        }
      }catch(e){ /* ignore and allow by default */ }
    },
    // for castling, en passant, pawn promotion — ensure UI matches game state
    onSnapEnd: function(){
      // Drag has ended
      isDragInProgress = false
      
      // If dragStartSquare is set, it means a drag started but no drop occurred (piece snapped back)
      // Treat this as a click-to-select
      if (dragStartSquare) {
        const squareEl = document.querySelector('.square-' + dragStartSquare)
        if (squareEl) {
          handleSquareClick(dragStartSquare, squareEl)
        }
        dragStartSquare = null
      }
      
      try{
        // If we have a pending castling animation, animate a subtle rook slide
        if (__castlingPending){
          const pending = __castlingPending
          __castlingPending = null
          try{
            const mv = pending.move
            if (mv && mv.flags && (String(mv.flags).indexOf('k') !== -1 || String(mv.flags).indexOf('q') !== -1)){
              // infer rook squares by comparing rook locations before/after
              const before = new Chess(); before.load(pending.startFEN)
              const after = new Chess(); after.load(pending.endFEN)
              const files = ['a','b','c','d','e','f','g','h']
              const ranks = ['1','2','3','4','5','6','7','8']
              const beforeRooks = []
              const afterRooks = []
              for (let r of ranks){
                for (let f of files){
                  const sq = f + r
                  try{ const p1 = before.get(sq); if (p1 && p1.type === 'r' && p1.color === mv.color) beforeRooks.push(sq) }catch(e){}
                  try{ const p2 = after.get(sq); if (p2 && p2.type === 'r' && p2.color === mv.color) afterRooks.push(sq) }catch(e){}
                }
              }
              const rookFrom = beforeRooks.find(sq => afterRooks.indexOf(sq) === -1)
              const rookTo = afterRooks.find(sq => beforeRooks.indexOf(sq) === -1)
              if (rookFrom && rookTo){
                // create a temporary position where the king is in its final square but the rook remains
                const tmp = new Chess(); tmp.load(pending.startFEN)
                try{ tmp.remove(mv.from) }catch(e){}
                try{ tmp.put({type:'k',color:mv.color}, mv.to) }catch(e){}
                // set this position so the king looks moved but rook hasn't slid yet
                try{ board.position(tmp.fen()) }catch(e){}
                // animate rook slide, then restore final position
                setTimeout(()=>{
                  try{ board.move(rookFrom + '-' + rookTo) }catch(e){}
                  setTimeout(()=>{ try{ board.position(pending.endFEN) }catch(e){} }, 220)
                }, 60)
                return
              }
            }
          }catch(e){ /* fallthrough to default */ }
        }
        // default behavior: show final game FEN
        try{ board.position(game.fen()) }catch(e){}
      }catch(e){}
    },
    pieceTheme: '/static/img/chesspieces/{piece}.png'
  })
  
  // Click-to-move functionality
  // Logic: pointerdown on a square = candidate for moving
  // If pointer leaves square before pointerup = drag move
  // If pointerup on same square = click-to-move (select piece)
  
  // Handle click-to-move logic (accessible to both pointer events and onSnapEnd)
  function handleSquareClick(square, squareEl) {
    const piece = game.get(square)
    const boardEl = document.getElementById('board')
    
    // First click: select a piece
    if (!selectedSquare) {
      // Only select pieces of the correct color for the side to move
      if (piece && piece.color === game.turn()) {
        selectedSquare = square
        // Highlight the selected square with purple
        if (squareEl) squareEl.classList.add('highlight1-32417')
      }
    } 
    // Second click: make the move, deselect, or reselect
    else {
      // If clicking the same square, deselect it
      if (square === selectedSquare) {
        clearClickToMoveSelection()
        return
      }
      
      // If clicking another piece of the same color, select it instead (reselect)
      if (piece && piece.color === game.turn()) {
        // Remove highlight from old square
        clearClickToMoveSelection()
        // Highlight new square
        selectedSquare = square
        if (squareEl) squareEl.classList.add('highlight1-32417')
        return
      }
      
      // Otherwise, attempt to move from selectedSquare to this square
      // Check if the move is legal before animating
      const legalMoves = game.moves({square: selectedSquare, verbose: true})
      const isLegal = legalMoves.some(m => m.to === square)
      
      if (!isLegal) {
        // Invalid move - keep the piece selected
        return
      }
      
      // Move is legal - animate it and then validate/submit
      const moveNotation = selectedSquare + '-' + square
      board.move(moveNotation)
      
      // Trigger onDrop to validate and handle the move
      // onDrop will update the game state and submit to server
      const sourceSquare = selectedSquare
      
      // Clear selection AFTER triggering the move
      clearClickToMoveSelection()
      
      onDrop(sourceSquare, square)
      
      // Update board position to match game state after a short delay
      // This ensures castling, en passant, and promotion are properly displayed
      setTimeout(() => {
        try {
          board.position(game.fen())
        } catch(e) {
          logError('Failed to update board after click-to-move:', e)
        }
      }, 200)
    }
  }
  
  const setupClickToMove = () => {
    const boardEl = document.getElementById('board')
    if (!boardEl) return
    
    let pointerDownSquare = null
    let pointerDownTime = null
    // isDragInProgress is now a global variable shared with onDragStart
    
    // Use capture phase (true) to intercept events before chessboard.js
    boardEl.addEventListener('pointerdown', function(e) {
      if (!allowMoves) return
      
      // Find the square that was pressed
      let squareEl = e.target
      let attempts = 0
      while (squareEl && !squareEl.classList.contains('square-55d63') && attempts < 10) {
        squareEl = squareEl.parentElement
        attempts++
      }
      
      if (squareEl && squareEl.classList.contains('square-55d63')) {
        pointerDownSquare = squareEl.getAttribute('data-square')
        pointerDownTime = Date.now()
        isDragInProgress = false
      }
    }, true) // Use capture phase
    
    // We no longer need pointermove detection since chessboard.js will handle drags
    // We just need to detect quick clicks
    
    boardEl.addEventListener('pointerup', function(e) {
      if (!pointerDownSquare) return
      
      // If a drag is in progress, chessboard.js is handling it
      if (isDragInProgress) {
        pointerDownSquare = null
        pointerDownTime = null
        isDragInProgress = false
        return
      }
      
      // Pointer stayed on the same square - this is a click-to-move action
      // Find the square where pointer was released
      let squareEl = e.target
      let attempts = 0
      while (squareEl && !squareEl.classList.contains('square-55d63') && attempts < 10) {
        squareEl = squareEl.parentElement
        attempts++
      }
      
      if (squareEl && squareEl.classList.contains('square-55d63')) {
        const square = squareEl.getAttribute('data-square')
        
        // Only handle if released on the same square as pressed
        if (square === pointerDownSquare) {
          handleSquareClick(square, squareEl)
        }
      }
      
      pointerDownSquare = null
      pointerDownTime = null
      isDragInProgress = false
    }, true) // Use capture phase
  }
  
  // Setup click handlers after board is created
  setupClickToMove()
  
  // Responsive: ensure chessboard recomputes its pixel size based on the
  // Bootstrap column/container width. chessboard.js exposes a `resize`
  // method that recalculates square sizes from the container width.
  const resizeBoard = () => {
    try{
      const boardEl = document.getElementById('board')
      if (!boardEl) return
      // allow our CSS max-width to constrain the container while keeping width fluid
      boardEl.style.width = '100%'
      // trigger the chessboard library to resize internal elements
      if (board && typeof board.resize === 'function') board.resize()
    }catch(e){ if (window.__CP_DEBUG) console.debug('resizeBoard failed', e) }
  }
  // debounce helper
  let _rb_to = null
  const scheduleResize = () => { clearTimeout(_rb_to); _rb_to = setTimeout(resizeBoard, 120) }
  // Call once immediately to ensure initial sizing
  scheduleResize()
  // Recompute on window resize and orientation change
  window.addEventListener('resize', scheduleResize, {passive:true})
  window.addEventListener('orientationchange', scheduleResize)
  
  document.getElementById('next').addEventListener('click', loadPuzzle)
  // ensure Hint button matches Next button styling and initial enabled/disabled state
  try{
    const nextBtn = document.getElementById('next')
    const hintBtn = document.getElementById('hint')
    if (nextBtn && hintBtn){
      // copy className to match appearance (keeps margins/spacings consistent)
      hintBtn.className = nextBtn.className
      // by default, hint should be enabled only when a puzzle is loaded; disable until loadPuzzle runs
      hintBtn.disabled = true
    }
  }catch(e){}
  loadPuzzle()
})

// Also trigger a board resize after a puzzle is loaded to handle cases where
// the board was hidden or the container width changed before initialization.
// This is a best-effort call; if the board isn't initialized yet the call is noop.
const postPuzzleResize = () => {
  try{ if (board && typeof board.resize === 'function') board.resize() }catch(e){}
}

// Hook into loadPuzzle to trigger a resize after the puzzle is rendered.
// We wrap the original loadPuzzle if present (to avoid redefining) and
// ensure the resize runs after loadPuzzle completes its async work.
if (typeof loadPuzzle === 'function') {
  const _origLoad = loadPuzzle
  loadPuzzle = async function(){
    await _origLoad()
    try{ postPuzzleResize() }catch(e){}
  }
}

// Inline feedback is used; modal removed
