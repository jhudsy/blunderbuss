// Ensure CP_DEBUG exists and provide easy runtime toggles; silence debug logs unless enabled
if (typeof window !== 'undefined') {
  try {
    // Allow enabling debug via URL (?debug=1)
    const params = new URLSearchParams(window.location.search || '')
    const wantDebug = params.get('debug') === '1'
    if (wantDebug) {
      window.__CP_DEBUG = true
    } else if (typeof window.__CP_DEBUG === 'undefined') {
      window.__CP_DEBUG = false
    }
  } catch(e) { /* ignore */ }
  if (window.__CP_DEBUG) {
    try { if (!console.debug) console.debug = console.log.bind(console) } catch(e){}
  } else {
    try { console.debug = function(){} } catch(e){}
  }
}

// Safe debug logger
function dbg(){
  if (!window || !window.__CP_DEBUG) return
  try { console.debug.apply(console, arguments) } catch(e) { try { console.log.apply(console, arguments) } catch(_){} }
}

// Helper: safe element getter

function $(id) {
  return document.getElementById(id);
}

// Helper: safe text setter
function setText(id, text) {
  const el = $(id)
  if (el) el.textContent = text
}

// Helper: safe display setter
function setDisplay(id, value) {
  const el = $(id)
  if (el) el.style.display = value
}

// Helper: safe console call with guard
function safeLog(fn, ...args) {
  try { fn.apply(console, args) } catch(e) {}
}

// ============================================================================
// Constants
// ============================================================================

const STOCKFISH_INIT_TIMEOUT_MS = 5000;
const EVALUATION_TIMEOUT_MS = 1000;
const EVALUATION_MOVETIME_MS = 850;
const EVALUATION_MOVETIME_PRECOMPUTE_MS = 5000; // Longer thinking time for initial position
const EVALUATION_MIN_MOVETIME_MS = 850; // Minimum thinking time before interruption
const EVALUATION_FALLBACK_DEPTH = 7;
const STOCKFISH_THREADS = 2;

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
let evaluationIdCounter = 0 // Unique ID for each evaluation to prevent race conditions

// Engine preference ("lite" | "full"). Default to lite; persisted via cookie
let ENGINE_CHOICE = 'lite'

// Pre-evaluation cache for responsiveness
// Stores the best move and its CP from the starting position of the current puzzle
let preEvalCache = {
  fen: null,
  bestMoveUci: null,
  bestMoveCp: null,
  inFlight: null, // Promise while computing
  startTime: null, // Track when evaluation started
  canInterrupt: false // Flag indicating if evaluation can be interrupted
}

// ============================================================================
// Stockfish Engine Functions
// ============================================================================

/**
 * Initialize the Stockfish engine (17.1 lite via Web Worker + WASM)
 */
function initStockfish() {
  try {
    dbg('[SF] initStockfish(): starting initialization')
    if (!window.__CP_DEBUG) safeLog(console.info, '[SF] Tip: add ?debug=1 to the URL to enable verbose engine logs')
    
    // Detect if SharedArrayBuffer is available and context is isolated
    if (typeof SharedArrayBuffer === 'undefined' || (typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated)) {
      safeLog(console.info, '[SF] crossOriginIsolated =', (typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : '(undefined)'))
      showEngineError('Chess engine requires cross-origin isolation (COOP/COEP). Please use HTTPS and ensure server sends proper headers.');
      dbg('[SF] initStockfish(): SharedArrayBuffer not available or not cross-origin isolated')
      return;
    }
    
    showEngineLoadingSpinner();

    // Select worker script: load the engine's own worker JS directly so it resolves
    // its WASM relative to itself (avoids wrapper path inference issues)
    const workerScript = ENGINE_CHOICE === 'full'
      ? '/static/vendor/stockfish/stockfish-17.1-8e4d048.js'
      : '/static/vendor/stockfish/stockfish-17.1-lite-51f59da.js'
    dbg('[SF] initStockfish(): creating worker', { choice: ENGINE_CHOICE, workerScript })

    // Use dedicated worker wrapper that loads the selected Stockfish WASM
    stockfishWorker = new Worker(workerScript);
    dbg('[SF] initStockfish(): worker created')

    stockfishWorker.onmessage = function(e) {
      const message = e.data;
      if (typeof message === 'string' && (message.startsWith('DEBUG_FETCH') || message.startsWith('DEBUG_FETCH_STATUS'))) {
        safeLog(console.warn, '[SF][worker]', message)
        return;
      }
      
      // Log all message types when debug is enabled to diagnose searchmoves issues
      if (window.__CP_DEBUG && typeof message === 'string') {
        if (message.startsWith('info')) {
          // Log info messages if we have an active evaluation with searchMove
          if (currentEvaluationCallback && currentEvaluationCallback.searchMove) {
            const depthMatch = message.match(/depth (\d+)/);
            const cpMatch = message.match(/score cp (-?\d+)/);
            if (depthMatch && parseInt(depthMatch[1]) % 4 === 0) {
              // (debug) searchmoves info logging removed
            }
          }
        } else if (message.startsWith('bestmove')) {
          console.log('[SF][bestmove received]', {
            hasCallback: !!currentEvaluationCallback,
            searchMove: currentEvaluationCallback ? currentEvaluationCallback.searchMove : null,
            msg: message
          });
        }
      }
      
      // Only log first info line to avoid flooding
      if (typeof message === 'string' && message.startsWith('info') && !stockfishWorker.__loggedFirstInfo) {
        dbg('[SF] onmessage: first info line received')
        stockfishWorker.__loggedFirstInfo = true
      }
      
      // Handle error messages
      if (typeof message === 'string' && message.startsWith('ERROR:')) {
        logError('Stockfish error:', message);
        dbg('[SF] onmessage: ERROR from worker', message)
        stockfishReady = false;
        showEngineError('Chess engine failed. Puzzle validation may not work correctly.');
        return;
      }
      
      if (message === 'uciok') {
        dbg('[SF] onmessage: uciok (engine ready)')
        stockfishReady = true;
        hideEngineLoadingSpinner();
        allowMoves = true;
        
        // Restore default info text if we were showing loading state
        const infoEl = $('info')
        if (infoEl && /Loading chess engine/i.test(infoEl.textContent)) {
          infoEl.textContent = 'Make the correct move.';
        }
        
        // Try to configure the engine to use multiple threads
        stockfishWorker.postMessage(`setoption name Threads value ${STOCKFISH_THREADS}`)
        dbg('[SF] ready:', { threadsRequested: STOCKFISH_THREADS, choice: ENGINE_CHOICE })
        console.debug('[SF] engine options: Threads=' + STOCKFISH_THREADS)
        
        updateEngineDropdownLabel()
        if (currentPuzzle && currentPuzzle.fen) precomputeBestEval(currentPuzzle.fen)
      } else if (message.startsWith('info') && currentEvaluationCallback) {
        // Ignore stale info lines from previous evaluations
        // Only process info lines after the go command has been sent for this evaluation
        if (!currentEvaluationCallback.goCommandSent) {
          if (window.__CP_DEBUG) {
            console.debug('[SF][stale] ignoring info line before go command sent', {
              evalId: currentEvaluationCallback.evalId,
              message: message.substring(0, 80)
            });
          }
          return;
        }
        
        // Parse centipawn score from info messages
        const cpMatch = message.match(/score cp (-?\d+)/);
        const mateMatch = message.match(/score mate (-?\d+)/);
        const depthMatch = message.match(/depth (\d+)/);
        const pvMatch = message.match(/\bpv\s+(\S+)/);
        
        // Log info lines when searchMove is active (to debug searchmoves issues)
        if (currentEvaluationCallback.searchMove && window.__CP_DEBUG) {
          const d = depthMatch ? parseInt(depthMatch[1]) : null
          const scoreStr = cpMatch ? cpMatch[1] : (mateMatch ? ('mate ' + mateMatch[1]) : '?')
          if (d && d % 3 === 0) { // Log every 3rd depth
            console.debug('[SF][searchmoves] info', { 
              searchMove: currentEvaluationCallback.searchMove, 
              depth: d, 
              score: scoreStr, 
              pv: pvMatch ? pvMatch[1] : '(none)',
              fullMsg: message.substring(0, 120)
            })
          }
        }
        
        // Accept any depth result for fast response (movetime mode)
        if (depthMatch) {
          if (cpMatch) {
            currentEvaluationCallback.latestCp = parseInt(cpMatch[1]);
          } else if (mateMatch) {
            // Convert mate scores to very high/low centipawn values
            currentEvaluationCallback.latestCp = parseInt(mateMatch[1]) > 0 ? 10000 : -10000;
          }
          // Capture best move from PV line - always take the latest one
          if (pvMatch) {
            currentEvaluationCallback.bestMove = pvMatch[1];
          }
          // Rate-limited debug log of depth/score/pv
          const d = depthMatch ? parseInt(depthMatch[1]) : null
          if (window.__CP_DEBUG && d && (!currentEvaluationCallback._lastLoggedDepth || d >= currentEvaluationCallback._lastLoggedDepth + 4)){
            const scoreStr = cpMatch ? (parseInt(cpMatch[1]) / 100).toFixed(2) : (mateMatch ? ('mate ' + mateMatch[1]) : '?')
            // (debug) info logging removed
            currentEvaluationCallback._lastLoggedDepth = d
          }
          // Always surface precompute phase info lines with a clear tag (rate-limited separately)
          if (currentEvaluationCallback.isPrecompute && d && (!currentEvaluationCallback._lastLoggedPrecomputeDepth || d >= currentEvaluationCallback._lastLoggedPrecomputeDepth + 6)){
            const preScoreStr = cpMatch ? (parseInt(cpMatch[1]) / 100).toFixed(2) : (mateMatch ? ('mate ' + mateMatch[1]) : '?')
            // (debug) precompute info logging removed
            currentEvaluationCallback._lastLoggedPrecomputeDepth = d
          }
          
          // For precompute evaluations, also update the cache in real-time
          if (currentEvaluationCallback.isPrecompute && preEvalCache.fen === currentEvaluationCallback.fen) {
            if (currentEvaluationCallback.bestMove) {
              preEvalCache.bestMoveUci = currentEvaluationCallback.bestMove;
            }
            if (currentEvaluationCallback.latestCp !== null) {
              preEvalCache.bestMoveCp = currentEvaluationCallback.latestCp;
            }
          }
        }
      } else if (message.startsWith('bestmove') && currentEvaluationCallback) {
        // Extract bestmove from the command (format: "bestmove e2e4" or "bestmove e2e4 ponder e7e5")
        const bestmoveMatch = message.match(/bestmove\s+(\S+)/);
        if (bestmoveMatch && !currentEvaluationCallback.bestMove) {
          currentEvaluationCallback.bestMove = bestmoveMatch[1];
        }
        
        // Debug: log final bestmove for this evaluation; surface precompute tag
        const __cb = currentEvaluationCallback;
        if (__cb && __cb.isPrecompute) {
          const cpVal = (typeof __cb.latestCp === 'number') ? __cb.latestCp : null
          const pawnsStr = (cpVal !== null) ? (cpVal/100).toFixed(2) : null
          console.log('[SF][precompute] bestmove', { uci: __cb.bestMove || '(none)', cp: cpVal, pawns: pawnsStr })
        }
        dbg('[SF] bestmove:', __cb ? (__cb.bestMove || '(none)') : '(none)')
        
        // Evaluation complete
        clearTimeout(evaluationTimeout);
        const callback = currentEvaluationCallback;
        currentEvaluationCallback = null;
        evaluationInProgress = false;
        
        // Debug log for bestmove resolution
        if (window.__CP_DEBUG) {
          console.log('[SF][bestmove] resolving evaluation', {
            searchMove: callback ? callback.searchMove : null,
            latestCp: callback ? callback.latestCp : null,
            bestMove: callback ? callback.bestMove : null,
            willFallback: callback && callback.latestCp === null && !callback.isFallback
          });
        }
        
        if (callback.latestCp !== null) {
          callback.resolve({ cp: callback.latestCp, bestMove: callback.bestMove || null });
        } else {
          // Sometimes movetime returns bestmove without info lines (simple positions)
          // If this is already a fallback attempt, the engine is not working properly
          if (callback.isFallback) {
            dbg('Fallback depth search also had no cp - engine failure');
            callback.reject(new Error('Chess engine failed to evaluate position'));
            return;
          }
          
          // Fall back to a quick depth search to ensure we get a score
          dbg(`No cp from movetime, retrying with depth ${EVALUATION_FALLBACK_DEPTH}${callback.searchMove ? ' (restricted to searchmove)' : ''}`);
          
          // Set up for fallback evaluation
          evaluationInProgress = true;
          currentEvaluationCallback = {
            resolve: callback.resolve,
            reject: callback.reject,
            latestCp: null,
            bestMove: null,
            fen: callback.fen,
            isFallback: true,
            isPrecompute: false,
            searchMove: callback.searchMove || null
          };
          
          // Use a shallow depth for quick fallback
          try {
            stockfishWorker.postMessage('position fen ' + callback.fen);
            if (callback.searchMove) {
              stockfishWorker.postMessage(`go depth ${EVALUATION_FALLBACK_DEPTH} searchmoves ${callback.searchMove}`);
            } else {
              stockfishWorker.postMessage(`go depth ${EVALUATION_FALLBACK_DEPTH}`);
            }
          } catch(e) {
            // If we can't even send the command, engine has failed
            evaluationInProgress = false;
            currentEvaluationCallback = null;
            dbg('Fallback command failed - engine error');
            callback.reject(new Error('Chess engine failed to evaluate position'));
          }
        }
      }
    };

    stockfishWorker.onerror = function(error) {
      logError('Stockfish worker error:', error);
      dbg('[SF] worker.onerror', error)
      stockfishReady = false;
      showEngineError('Chess engine encountered an error. Please refresh the page.');
      hideEngineLoadingSpinner();
    };
    
    // Initialize UCI protocol with timeout
    stockfishWorker.postMessage('uci');
    dbg('[SF] sent: uci')
    
    // If engine doesn't respond within timeout, show error
    setTimeout(() => {
      if (!stockfishReady) {
        dbg('[SF] init timeout exceeded (showing warning)')
        try { console.warn('[SF] Engine initialization is taking longer than expected. Check network panel for worker and WASM file loads.'); } catch(e){}
        showEngineError('Chess engine is taking longer than expected to load. Puzzle validation may not work correctly.');
      }
    }, STOCKFISH_INIT_TIMEOUT_MS);
    
  } catch(e) {
    logError('Failed to initialize Stockfish:', e);
    dbg('[SF] initStockfish(): exception during init', e)
    stockfishReady = false;
    showEngineError('Failed to initialize chess engine. Please refresh the page.');
    hideEngineLoadingSpinner();
  }
}

/**
 * Switch engine at runtime. Terminates current worker, clears state,
 * persists selection to cookie, shows spinner, and reinitializes.
 */
function switchEngine(choice) {
  const normalized = (choice || '').toLowerCase() === 'full' ? 'full' : 'lite'
  dbg('[SF] switchEngine(): request', { from: ENGINE_CHOICE, to: normalized })
  if (normalized === ENGINE_CHOICE && stockfishReady) {
    updateEngineDropdownLabel()
    dbg('[SF] switchEngine(): already on requested engine and ready; no-op')
    return
  }
  // Cancel any ongoing evaluations and precompute
  if (stockfishWorker) stockfishWorker.postMessage('stop')
  clearTimeout(evaluationTimeout)
  evaluationInProgress = false
  currentEvaluationCallback = null
  Object.assign(preEvalCache, { inFlight: null, startTime: null, canInterrupt: false, bestMoveUci: null, bestMoveCp: null })

  // Terminate existing worker
  if (stockfishWorker) stockfishWorker.terminate()
  stockfishWorker = null
  stockfishReady = false

  // Temporarily disallow moves during engine switch
  allowMoves = false
  showEngineLoadingSpinner()
  setText('info', 'Loading chess engine...')

  // Persist preference and update label
  ENGINE_CHOICE = normalized
  setCookie('sf_engine', ENGINE_CHOICE, 365)
  updateEngineDropdownLabel()

  // Re-init engine
  initStockfish()
  dbg('[SF] switchEngine(): re-initializing worker')

  // If a puzzle is already loaded, kick precompute again
  if (currentPuzzle && currentPuzzle.fen) precomputeBestEval(currentPuzzle.fen)
}

/**
 * Show engine error message to user
 */
function showEngineError(message) {
  const infoEl = $('info');
  if (infoEl) {
    infoEl.textContent = message;
    infoEl.style.color = '#dc3545'; // Bootstrap danger color
  }
}

/**
 * Show spinner while the engine (WASM) loads
 */
/**
 * Generic spinner show/hide for info element
 */
function toggleSpinner(spinnerId, show, defaultMessage = '') {
  if (show) {
    const infoEl = $('info');
    if (!infoEl) return;
    let spinner = $(spinnerId);
    if (!spinner) {
      spinner = document.createElement('span');
      spinner.id = spinnerId;
      spinner.className = 'spinner-border spinner-border-sm me-2';
      spinner.setAttribute('role', 'status');
      spinner.setAttribute('aria-hidden', 'true');
    }
    if (infoEl.firstChild) {
      infoEl.insertBefore(spinner, infoEl.firstChild);
    } else {
      infoEl.appendChild(spinner);
    }
    if (defaultMessage && (!infoEl.textContent || /Make the correct move\.?/.test(infoEl.textContent))) {
      infoEl.textContent = defaultMessage;
      infoEl.insertBefore(spinner, infoEl.firstChild);
    }
  } else {
    const spinner = $(spinnerId);
    if (spinner && spinner.parentNode) {
      spinner.parentNode.removeChild(spinner);
    }
  }
}

function showEngineLoadingSpinner() {
  toggleSpinner('engine-loading-spinner', true, ' Loading chess engine...');
}

function hideEngineLoadingSpinner() {
  toggleSpinner('engine-loading-spinner', false);
}

/**
 * Update the engine dropdown label to reflect current selection
 */
function updateEngineDropdownLabel(){
  const el = $('engineDropdownLabel')
  if (!el) return
  el.textContent = ENGINE_CHOICE === 'full' ? 'Full' : 'Lite'
}

function showEvaluatingSpinner() {
  toggleSpinner('evaluation-spinner', true);
}

function hideEvaluatingSpinner() {
  toggleSpinner('evaluation-spinner', false);
}

/**
 * Precompute the best move and its evaluation for the starting position.
 * Retries briefly if the engine isn't ready yet.
 */
function precomputeBestEval(startFEN, attempt = 0) {
  try {
    dbg('[SF] precomputeBestEval(): called', { attempt, ready: stockfishReady })
    // Reset cache if FEN changed
    if (preEvalCache.fen !== startFEN) {
      preEvalCache = { fen: startFEN, bestMoveUci: null, bestMoveCp: null, inFlight: null, startTime: null, canInterrupt: false };
    }
    // If already computed or in progress, do nothing
    if (preEvalCache.bestMoveUci || preEvalCache.inFlight) return;

    // If engine not ready yet, retry shortly (cap attempts)
    if (!stockfishReady) {
      if (attempt < 15) {
        dbg('[SF] precomputeBestEval(): engine not ready; retry soon', { nextAttempt: attempt + 1 })
        setTimeout(() => precomputeBestEval(startFEN, attempt + 1), 200);
      }
      return;
    }

    // Kick off evaluation and store promise
    preEvalCache.startTime = Date.now();
    preEvalCache.canInterrupt = false; // Will be set to true after minimum time
    dbg('[SF] precomputeBestEval(): starting engine analysis', { movetime: EVALUATION_MOVETIME_PRECOMPUTE_MS })
    
    // Set flag to allow interruption after minimum time has elapsed
    setTimeout(() => {
      if (preEvalCache.fen === startFEN && preEvalCache.inFlight) {
        preEvalCache.canInterrupt = true;
        dbg('[SF] precomputeBestEval(): canInterrupt set true')
      }
    }, EVALUATION_MIN_MOVETIME_MS);
    
    preEvalCache.inFlight = evaluatePosition(startFEN, null, EVALUATION_MOVETIME_PRECOMPUTE_MS, true)
      .then(({ cp, bestMove }) => {
        preEvalCache.bestMoveUci = bestMove || null;
        preEvalCache.bestMoveCp = typeof cp === 'number' ? cp : null;
        dbg('[SF] precomputeBestEval(): cached', { 
          bestMove, 
          cp: preEvalCache.bestMoveCp,
          pawns: preEvalCache.bestMoveCp !== null ? (preEvalCache.bestMoveCp / 100).toFixed(2) : null,
          thinkTime: Date.now() - (preEvalCache.startTime || Date.now()) 
        })
      })
      .catch(() => { /* ignore precompute failures; will fallback at move time */ })
      .finally(() => {
        preEvalCache.inFlight = null;
        preEvalCache.startTime = null;
        preEvalCache.canInterrupt = false;
        dbg('[SF] precomputeBestEval(): finished')
      });
  } catch(e) {
    // ignore precompute errors to avoid impacting UI
  }
}

/**
 * Stop the current precomputation if it's interruptible.
 * Returns the best result found so far, or null if not enough time has elapsed.
 */
function interruptPrecompute() {
  if (!preEvalCache.inFlight) return null;
  
  // Only interrupt if minimum time has elapsed
  if (!preEvalCache.canInterrupt) {
    dbg('[SF] interruptPrecompute(): cannot interrupt yet (minimum time not elapsed)')
    return null;
  }
  
  dbg('[SF] interruptPrecompute(): stopping engine', { elapsed: Date.now() - (preEvalCache.startTime || Date.now()), hasResult: !!(preEvalCache.bestMoveUci && typeof preEvalCache.bestMoveCp === 'number') })
  
  // Stop the engine
  try {
    stockfishWorker.postMessage('stop');
  } catch(e) {
    dbg('[SF] interruptPrecompute(): failed to send stop', e)
  }
  
  // Clear the evaluation state so new evaluations can proceed
  if (evaluationInProgress && currentEvaluationCallback) {
    clearTimeout(evaluationTimeout);
    evaluationInProgress = false;
    currentEvaluationCallback = null;
  }
  
  // Clear the precompute in-flight state
  preEvalCache.inFlight = null;
  preEvalCache.startTime = null;
  preEvalCache.canInterrupt = false;
  
  // Return whatever result we have so far (may be incomplete)
  if (preEvalCache.bestMoveUci && typeof preEvalCache.bestMoveCp === 'number') {
    dbg('[SF] interruptPrecompute(): returning partial result')
    return {
      bestMoveUci: preEvalCache.bestMoveUci,
      bestMoveCp: preEvalCache.bestMoveCp
    };
  }
  
  dbg('[SF] interruptPrecompute(): no partial result available')
  return null;
}

/**
 * Evaluate a FEN position using Stockfish
 * @param {string} fen - The FEN position to evaluate
 * @param {string} searchMove - Optional UCI move to restrict search to (e.g., "e2e4")
 * @param {number} movetime - Optional movetime in milliseconds (defaults to EVALUATION_MOVETIME_MS)
 * @param {boolean} isPrecompute - Whether this is a precomputation (affects timeout handling)
 * @returns {Promise<{cp: number, bestMove: string}>} - The centipawn evaluation and best move
 */
function evaluatePosition(fen, searchMove = null, movetime = null, isPrecompute = false) {
  return new Promise((resolve, reject) => {
    if (!stockfishReady) {
      reject(new Error('Stockfish not ready'));
      return;
    }
    
    if (evaluationInProgress) {
      reject(new Error('Evaluation already in progress'));
      return;
    }
    
    // Use provided movetime or default
    const actualMovetime = movetime !== null ? movetime : EVALUATION_MOVETIME_MS;
    
    // Assign unique evaluation ID to prevent race conditions
    const evalId = ++evaluationIdCounter;
    dbg('[SF] evaluatePosition(): start', { evalId, hasSearchMove: !!searchMove, movetime: actualMovetime, isPrecompute })
    
    evaluationInProgress = true;
    currentEvaluationCallback = {
      resolve: resolve,
      reject: reject,
      latestCp: null,
      bestMove: null,
      fen: fen,
      isPrecompute: isPrecompute,
      searchMove: searchMove || null,
      evalId: evalId, // Tag this evaluation with unique ID
      goCommandSent: false // Track when go command is sent
    };
    
    // Log evaluation start for debugging
    if (window.__CP_DEBUG) {
      console.log('[SF][evaluatePosition] starting', {
        evalId: evalId,
        hasSearchMove: !!searchMove,
        searchMove: searchMove,
        movetime: actualMovetime,
        isPrecompute: isPrecompute,
        fen: fen.substring(0, 50) + '...'
      });
    }
    
    // Set timeout for evaluation - allow extra time for precompute and a bit over movetime to receive bestmove
  const timeoutDuration = isPrecompute ? (actualMovetime + 500) : EVALUATION_TIMEOUT_MS;
    evaluationTimeout = setTimeout(() => {
      if (currentEvaluationCallback) {
        const callback = currentEvaluationCallback;
        currentEvaluationCallback = null;
        evaluationInProgress = false;
        // If we have any evaluation, use it
        if (callback.latestCp !== null) {
          dbg('[SF] evaluatePosition(): timeout but have cp; resolving', { cp: callback.latestCp, bestMove: callback.bestMove })
          callback.resolve({ cp: callback.latestCp, bestMove: callback.bestMove || null });
        } else {
          // Timeout without evaluation
          // If this was a fallback attempt, it's a real engine failure
          if (callback.isFallback) {
            dbg('[SF] evaluatePosition(): fallback timeout — engine failure')
            callback.reject(new Error('Chess engine failed to evaluate position'));
          } else {
            // Primary evaluation timeout — do NOT resolve with neutral 0.
            // Instead, request the engine to stop so it emits a 'bestmove',
            // which our bestmove handler will use to trigger a proper fallback
            // (respecting searchMove if set).
            dbg('[SF] evaluatePosition(): primary timeout; sending stop to obtain bestmove and trigger fallback')
            try { stockfishWorker.postMessage('stop') } catch(e){}
            // Leave currentEvaluationCallback in place; bestmove handler will proceed.
          }
        }
      }
    }, timeoutDuration);
    
    // Send position and request evaluation with a fixed movetime budget
    stockfishWorker.postMessage('position fen ' + fen);
    // Send isready as a synchronization barrier to ensure engine has processed position
    // and cleared any stale state from previous evaluations
    stockfishWorker.postMessage('isready');
    dbg('[SF] evaluatePosition(): sent position + isready', { fen })
    // Request thinking time; we continue capturing the latest cp from info lines
    // If searchMove is specified, restrict search to that move only
    if (searchMove) {
      const cmd = `go movetime ${actualMovetime} searchmoves ${searchMove}`;
      stockfishWorker.postMessage(cmd);
      currentEvaluationCallback.goCommandSent = true; // Mark that we've sent the go command
      dbg('[SF] evaluatePosition(): sent go movetime with searchmoves', { searchMove, cmd, movetime: actualMovetime })
      // Also log to console for verification
      dbg('[SF][UCI] position fen ' + fen)
      dbg('[SF][UCI] ' + cmd)
    } else {
      stockfishWorker.postMessage(`go movetime ${actualMovetime}`);
      currentEvaluationCallback.goCommandSent = true; // Mark that we've sent the go command
      dbg('[SF] evaluatePosition(): sent go movetime', { movetime: actualMovetime })
    }
  });
}

/**
 * Wait for the engine to become ready, with a timeout
 */
function awaitEngineReady(timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    if (stockfishReady) return resolve();
    const start = Date.now();
    const check = () => {
      if (stockfishReady) return resolve();
      if (Date.now() - start >= timeoutMs) return reject(new Error('Stockfish not ready'));
      setTimeout(check, 100);
    };
    check();
  });
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Error logger — always logs to console.error so issues are visible without debug.
 */
function logError(message, error) {
  try { console.error(message, error) } catch(e) { /* ignore */ }
}

/** Cookie helpers for persisting engine selection */
function setCookie(name, value, days) {
  try {
    let expires = ''
    if (days) {
      const d = new Date()
      d.setTime(d.getTime() + (days*24*60*60*1000))
      expires = '; expires=' + d.toUTCString()
    }
    document.cookie = name + '=' + encodeURIComponent(value) + expires + '; path=/'
  } catch(e) { /* ignore */ }
}

function getCookie(name) {
  try {
    const nameEQ = name + '='
    const ca = document.cookie.split(';')
    for (let i = 0; i < ca.length; i++) {
      let c = ca[i]
      while (c.charAt(0) === ' ') c = c.substring(1, c.length)
      if (c.indexOf(nameEQ) === 0) return decodeURIComponent(c.substring(nameEQ.length, c.length))
    }
  } catch(e) { /* ignore */ }
  return null
}

// Convert a UCI move to SAN using a temporary Chess instance
function uciToSan(fen, uci){
  try{
    if (!fen || !uci) return null
    const from = uci.slice(0,2)
    const to = uci.slice(2,4)
    const promo = uci.length > 4 ? uci.slice(4,5) : undefined
    const tmp = new Chess()
    tmp.load(fen)
    const m = tmp.move({ from, to, promotion: promo })
    return m ? m.san : null
  }catch(e){ return null }
}

// Format helpers for debug output
const format = {
  cp(cp){ try{ return (cp >= 0 ? '+' : '') + String(cp) }catch(e){ return String(cp) } },
  pawns(cp){ try{ return (cp/100).toFixed(2) }catch(e){ return String(cp) } }
}

// Compute win likelihood like the backend for debug summaries
function winLikelihoodJS(cp){
  try{
    return 50 + 50 * (2 / (Math.exp(-0.00368 * cp) + 1) - 1)
  }catch(e){ return null }
}

/**
 * Send a move to the server for validation
 */
async function sendMoveToServer(initialCp, moveCp) {
  try {
    const response = await fetch('/check_puzzle', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        id: currentPuzzle.id,
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
    const btn = $('next')
    if (btn) btn.disabled = !enabled
  }
  if (delay > 0) setTimeout(action, delay)
  else action()
}

/**
 * Update the attempts counter display with color coding
 */
function updateAttemptsDisplay(remaining, total) {
  let attemptsEl = $('attemptsCounter');
  if (!attemptsEl) {
    // Create the attempts counter element if it doesn't exist
    const infoEl = $('info');
    if (infoEl) {
      attemptsEl = document.createElement('div');
      attemptsEl.id = 'attemptsCounter';
      attemptsEl.className = 'mt-2 fw-bold';
      infoEl.parentNode.insertBefore(attemptsEl, infoEl.nextSibling);
    }
  }
  
  if (attemptsEl && total > 0) {
    attemptsEl.textContent = `Attempts remaining: ${remaining}/${total}`;
    // Color coding based on attempts remaining
    if (remaining === total) {
      attemptsEl.style.color = 'green';
    } else if (remaining > 1) {
      attemptsEl.style.color = 'orange';
    } else {
      attemptsEl.style.color = 'red';
    }
    attemptsEl.style.display = '';
  } else if (attemptsEl) {
    attemptsEl.style.display = 'none';
  }
}

/**
 * Enable or disable the Hint button
 */
function setHintButtonEnabled(enabled) {
  const btn = $('hint')
  if (btn) btn.disabled = !enabled
}

/**
 * Update the ribbon XP display and animate if increased
 */
function updateRibbonXP(newXP) {
  if (typeof newXP === 'undefined') return
  
  const rx = $('ribbonXP')
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
    setText('info', 'Please log in to practice puzzles.')
    setDisplay('next', 'none')
    setDisplay('board', 'none')
    return
  }
  const data = await res.json()
  if (!res.ok){
    const err = data.error || 'Failed to load puzzle'
    // treat 'user not found' as a signal to prompt for login
    if (res.status === 401 || err.toLowerCase().includes('not logged in') || err.toLowerCase().includes('user not found')){
      setText('info', 'Please log in to practice puzzles.')
      setDisplay('next', 'none')
      setDisplay('board', 'none')
    } else {
      setText('info', err)
    }
    return
  }
  currentPuzzle = data
  // Remove any leftover 'See on lichess' link from a previous puzzle
  const old = $('seeOnLichessContainer')
  if (old && old.parentNode) old.parentNode.removeChild(old)
  // clear any square highlights from previous puzzle
  clearAllHighlights()
  
  // Reset click-to-move state
  clearClickToMoveSelection()
  
  // Clear any pending castling animation from previous puzzle
  __castlingPending = null

  // Disable hint button until puzzle is fully loaded and ready
  try {
    const hintBtn = $('hint')
    if (hintBtn) hintBtn.disabled = true
  } catch(e) {}

  // Check if we have a previous_fen to animate the opponent's move
  const hasPreviousFen = currentPuzzle.previous_fen && typeof currentPuzzle.previous_fen === 'string'
  
  dbg('[loadPuzzle] hasPreviousFen:', hasPreviousFen)
  dbg('[loadPuzzle] currentPuzzle.previous_fen:', currentPuzzle.previous_fen)
  dbg('[loadPuzzle] currentPuzzle.fen:', currentPuzzle.fen)
  
  if (hasPreviousFen) {
    dbg('[loadPuzzle] Entering animation branch')
    
    // Flip board orientation based on whose turn it will be AFTER the opponent moves
    // (i.e., the user's turn at the decision point)
    try{
      const tempGameForOrientation = new Chess(currentPuzzle.fen)
      const turn = tempGameForOrientation.turn()
      dbg('[loadPuzzle] Setting board orientation for turn:', turn)
      if (turn === 'b') board.orientation('black')
      else board.orientation('white')
    } catch(e){ 
      dbg('[loadPuzzle] Error setting orientation:', e)
    }
    
    // Show the position BEFORE the opponent's move
    game = new Chess()
    game.load(currentPuzzle.previous_fen)
    board.position(currentPuzzle.previous_fen, false)  // false = no animation for initial setup
    
    dbg('[loadPuzzle] Loaded previous_fen, board should show initial position')
    
    // Disable moves during opponent animation
    allowMoves = false
    
    // Compute the opponent's move by comparing previous_fen to current fen
    try {
      const tempGame = new Chess(currentPuzzle.previous_fen)
      const legalMoves = tempGame.moves({ verbose: true })
      
      dbg('[loadPuzzle] Looking for opponent move. Previous FEN:', currentPuzzle.previous_fen)
      dbg('[loadPuzzle] Target FEN:', currentPuzzle.fen)
      dbg('[loadPuzzle] Legal moves from previous position:', legalMoves.length)
      
      // Find the move that leads to current_fen
      // Compare only the position part of FEN (first 4 fields), ignoring move counters
      const targetFenParts = currentPuzzle.fen.split(' ').slice(0, 4).join(' ')
      let opponentMove = null
      for (const move of legalMoves) {
        tempGame.move(move)
        const reachedFenParts = tempGame.fen().split(' ').slice(0, 4).join(' ')
        if (reachedFenParts === targetFenParts) {
          opponentMove = move
          dbg('[loadPuzzle] Found opponent move:', move.san, 'from', move.from, 'to', move.to)
          break
        }
        tempGame.undo()
      }
      
      if (opponentMove) {
        dbg('[loadPuzzle] Found opponent move, preparing to animate')
        dbg('[loadPuzzle] Will animate move:', opponentMove.from + '-' + opponentMove.to)
        
        // Animate the opponent's move using chessboard.js move() method
        const moveNotation = opponentMove.from + '-' + opponentMove.to
        await new Promise(resolve => {
          // Brief pause before starting animation
          setTimeout(() => {
            dbg('[loadPuzzle] Starting animation after pause')
            // Set slow speed for opponent move animation
            if (typeof board.moveSpeed === 'function') {
              board.moveSpeed('slow')
            }
            dbg('[loadPuzzle] Calling board.move() with:', moveNotation)
            board.move(moveNotation)
            dbg('[loadPuzzle] board.move() called, waiting for animation to complete')
            // Wait for slow animation to complete (~300ms) plus a bit extra
            setTimeout(() => {
              // Reset to fast speed for user moves
              if (typeof board.moveSpeed === 'function') {
                board.moveSpeed('fast')
              }
              dbg('[loadPuzzle] Animation timeout completed, speed reset to fast')
              resolve()
            }, 400) // slow animation duration + buffer
          }, 500) // 500ms pause before animation starts
        })
        
        dbg('[loadPuzzle] Animation complete, updating game state')
        // Update game state to current position after animation
        game.load(currentPuzzle.fen)
      } else {
        // Fallback: couldn't determine opponent move, just show current position
        dbg('[loadPuzzle] Could not determine opponent move, falling back to current position')
        dbg('[loadPuzzle] Tried to match:', targetFenParts)
        game.load(currentPuzzle.fen)
        board.position(currentPuzzle.fen)
      }
    } catch (e) {
      // Error computing opponent move, fall back to showing current position
      dbg('[loadPuzzle] Error animating opponent move:', e)
      game.load(currentPuzzle.fen)
      board.position(currentPuzzle.fen)
    }
    
    // Now enable solving
    allowMoves = true
    setText('info', 'Make the correct move.')
    
  } else {
    // No previous_fen: use original behavior (show current position immediately)
    game = new Chess()
    game.load(currentPuzzle.fen)
    board.position(currentPuzzle.fen)
    
    // flip board orientation if it's black to move in the FEN
    try{
      const turn = game.turn()
      if (turn === 'b') board.orientation('black')
      else board.orientation('white')
    } catch(e){ /* ignore */ }
    
    allowMoves = true
    setText('info', 'Make the correct move.')
  }


  // populate metadata if available
  const metaEl = $('puzzleMeta')
  if (metaEl){
    // Helper: escape HTML to avoid injection when using innerHTML
    const esc = (s) => String(s || '').replace(/[&<>"]'/g, function(m){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'})[m] })
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

  // hide any previously revealed correct move
  const cmc = $('correctMoveContainer')
  if (cmc) { cmc.style.display = 'none'; $('correctMoveText').textContent = '' }
  
  // Hide attempts counter when loading new puzzle
  const attemptsEl = $('attemptsCounter');
  if (attemptsEl) attemptsEl.style.display = 'none';
  
  // Ensure Next is disabled until the puzzle is answered
  setNextButtonEnabled(false);
  
  // Reset hint state
  hintUsedForCurrent = false
  
  try{
    const hintBtn = $('hint')
    const nextBtn = $('next')
    if (hintBtn){
      // Mirror Next button styling so the buttons look consistent
      if (nextBtn) hintBtn.className = nextBtn.className
      hintBtn.disabled = false
    }
  } catch(e){}
  
  // Refresh ribbon XP/streak for this user
  refreshRibbonState();

  // Precompute the best move evaluation for responsiveness while the user thinks
  // Start this during or after the opponent move animation for better performance
  try { precomputeBestEval(currentPuzzle.fen) } catch(e) { /* ignore */ }
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
  const maxAttempts = j.max_attempts || 3
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
    
    // Hide evaluation details on correct move; keep the message concise
    setText('info', 'Correct! Click Next to continue.');
    
    // Hide attempts counter on correct answer
    const attemptsEl = $('attemptsCounter');
    if (attemptsEl) attemptsEl.style.display = 'none';
    
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
    
    // Calculate win percentages from CP values
    const initialWin = (resolvedInitialCp != null) ? winLikelihoodJS(resolvedInitialCp) : null;
    const moveWin = (resolvedMoveCp != null) ? winLikelihoodJS(resolvedMoveCp) : null;
    
    // Determine which color made the move (from the FEN)
    const playerColor = startFEN.includes(' w ') ? 'White' : 'Black';
    
    // Format the win percentage message
    let evalMessage = 'Incorrect.';
    if (initialWin != null && moveWin != null) {
      evalMessage = `Incorrect. ${playerColor} winning chances changed from ${initialWin.toFixed(1)}% to ${moveWin.toFixed(1)}%.`;
    }
    
    // If attempts remain, allow another try
    if (!maxAttemptsReached && attemptsRemaining > 0) {
      setText('info', evalMessage);
      updateAttemptsDisplay(attemptsRemaining, maxAttempts);
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
    setText('info', `${evalMessage} Maximum attempts reached.`);
    updateAttemptsDisplay(0, maxAttempts);
    
    // Start reveal sequence using nested setTimeouts
    setTimeout(() => {
      // 1) Reset board to the starting position
      resetBoard(startFEN);

      // 2) Wait a little more before revealing the correct move
      setTimeout(() => {
        // 3) Reveal correct move if provided
        if (j.correct_san){
          const cmc = $('correctMoveContainer')
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
                  dbg('matched move in moves list:', m)
                  try{ revealCorrectMoveSquares(m.from, m.to, m.promotion, m.flags, temp.fen()) } catch(e){ board.position(startFEN) }
                  break
                }
              }
              dbg('fallback scan complete, no direct temp.move result')
            }
            
            // Ensure the global game is reset back to the starting position after reveal
            try{ game.load(startFEN) } catch(e){ /* ignore */ }
          }catch(e){ /* ignore reveal failures */ }
        }
        
        // Show badges if any and update UI
        const infoEl2 = $('info')
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
    dbg('onDrop called before puzzle loaded')
    return 'snapback'
  }

  const move = {from: source, to: target, promotion: 'q'}
  // capture the starting FEN so we can reset after a wrong move
  const startFEN = game.fen()
  
  // Helper: evaluate both positions and send to server
  async function evaluateAndSendMove(result, startFEN){
    try {
  // If the engine isn't ready yet, wait briefly and show a loading state
  if (!stockfishReady) {
    showEngineLoadingSpinner();
    setText('info', 'Loading chess engine...');
    try {
      await awaitEngineReady(6000);
    } catch(e) {
      // Still not ready — inform the user and revert move after a short delay
      hideEngineLoadingSpinner();
      setText('info', 'Chess engine not ready. Please wait a moment and try again.');
      // Re-enable Hint and allow another try shortly
      setHintButtonEnabled(true);
      setTimeout(() => {
        resetBoard(startFEN);
        allowMoves = true;
      }, 1200);
      return;
    } finally {
      // If the engine became ready, hide the loading spinner (evaluation spinner may be shown later)
      hideEngineLoadingSpinner();
    }
  }
  // Disable buttons to prevent double actions
  setNextButtonEnabled(false);
  setHintButtonEnabled(false);
      
  // We will only show the spinner if we actually need to run a second
  // evaluation (i.e., the player's move is not the best move).
      
      // CORRECT APPROACH: Make each move and evaluate the RESULTING position.
      // This gives us the position evaluation from the opponent's perspective,
      // which we negate to get the current player's advantage after the move.
      // IMPORTANT: Stockfish always returns CP from WHITE's perspective.
      
      // Determine whose turn it is (needed for perspective correction)
      let isWhiteToMove = true;
      try {
        const tmpGame = new Chess();
        tmpGame.load(startFEN);
        isWhiteToMove = tmpGame.turn() === 'w';
      } catch(e) {
        // Fallback: check FEN string directly
        const parts = startFEN.split(' ');
        isWhiteToMove = parts.length > 1 && parts[1] === 'w';
      }
      
      // 1. Get the best move from precomputation or compute it now
      // First, try to interrupt the precomputation if it's still running
      let interruptedResult = null;
      if (preEvalCache && preEvalCache.fen === startFEN && preEvalCache.inFlight) {
        interruptedResult = interruptPrecompute();
      }
      
      // Prefer cached best move if available
      let bestMoveUci = null;
      try {
        if (preEvalCache && preEvalCache.fen === startFEN) {
          if (preEvalCache.bestMoveUci) {
            bestMoveUci = preEvalCache.bestMoveUci;
          } else if (interruptedResult && interruptedResult.bestMoveUci) {
            bestMoveUci = interruptedResult.bestMoveUci;
            if (window.__CP_DEBUG) {
              console.debug('Using interrupted precomputation result:', interruptedResult);
            }
          } else if (preEvalCache.inFlight) {
            // Allow the precomputation to finish naturally
            await preEvalCache.inFlight;
            if (preEvalCache.bestMoveUci) {
              bestMoveUci = preEvalCache.bestMoveUci;
            }
          }
        }
      } catch(e) { /* ignore cache failures */ }

      if (!bestMoveUci) {
        // Need to compute best move now
        const bestEvalNow = await evaluatePosition(startFEN, null, EVALUATION_MOVETIME_PRECOMPUTE_MS);
        bestMoveUci = bestEvalNow.bestMove;
        
        // Store in cache for potential reuse
        try {
          preEvalCache.bestMoveUci = bestMoveUci;
          preEvalCache.bestMoveCp = typeof bestEvalNow.cp === 'number' ? bestEvalNow.cp : null;
        } catch(e) { /* ignore */ }
      }
      
      if (!bestMoveUci) {
        throw new Error('Engine did not provide a best move');
      }
      
      // Derive the baseline CP for the starting position from precompute (always from white's perspective)
      let baselineCp = null;
      try {
        const rawCp = (preEvalCache && preEvalCache.fen === startFEN && typeof preEvalCache.bestMoveCp === 'number')
          ? preEvalCache.bestMoveCp
          : (interruptedResult && typeof interruptedResult.bestMoveCp === 'number')
            ? interruptedResult.bestMoveCp
            : null;
        if (typeof rawCp === 'number') baselineCp = rawCp;
      } catch(e) { /* ignore */ }

      // 2. Convert the player's move to UCI format
      // The move has already been made in the game object (result contains the move details)
      const playerMoveUci = (result.from + result.to + (result.promotion || '')).toLowerCase();
      
      // Debug: log both UCI moves before comparison
      if (window.__CP_DEBUG) {
        console.log('[SF][compare moves]', {
          playerMoveUci,
          bestMoveUci: String(bestMoveUci).toLowerCase(),
          isMatch: playerMoveUci === String(bestMoveUci).toLowerCase()
        });
      }
      // 3. If player's move matches best move, avoid any further evaluation and use baseline
if (bestMoveUci && playerMoveUci === String(bestMoveUci).toLowerCase()) {
  const cp = (typeof baselineCp === 'number') ? baselineCp : 0;
  if (window.__CP_DEBUG) {
    const san = uciToSan(startFEN, playerMoveUci);
    console.log('[SF][eval] played best move; using precomputed baseline', {
      fen: startFEN,
      sideToMove: isWhiteToMove ? 'white' : 'black',
      move: { uci: playerMoveUci, san },
      baselineCp: cp,
      note: 'No additional evaluation performed'
    });
  }
  const json = await sendMoveToServer(cp, cp);
  handleCheckPuzzleResponse(json, source, target, startFEN, { initialCp: cp, moveCp: cp });
  return;
}      
      // 4. Player's move differs from best move - evaluate player's move from starting position
      // Show spinner and message while performing evaluation
      showEvaluatingSpinner();
      setText('info', 'Analyzing position...');
      
      // If we interrupted precompute, add a small delay to allow engine to flush stale info lines
      if (interruptedResult) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (window.__CP_DEBUG) {
          console.log('[SF][delay] waited 100ms after interrupt to clear stale engine messages');
        }
      }
      
      // Evaluate the starting position with searchmoves restricted to player's move
      // Engine returns CP from white's perspective
      const playerEval = await evaluatePosition(startFEN, playerMoveUci, EVALUATION_MOVETIME_MS);
      // Keep playerCp in white's perspective (don't negate)
      let playerCp = playerEval.cp;
      
      // Debug: detailed summary (best vs played)
      if (window.__CP_DEBUG){
        try{
          const bestSan = uciToSan(startFEN, bestMoveUci)
          const playedSan = uciToSan(startFEN, playerMoveUci)
          const initialWin = winLikelihoodJS(baselineCp)
          const moveWin = winLikelihoodJS(playerCp)
          console.log('[SF][eval] summary', {
            fen: startFEN,
            sideToMove: isWhiteToMove ? 'white' : 'black',
            best: { uci: bestMoveUci, san: bestSan, cp: baselineCp, pawns: format.pawns(baselineCp) },
            played: { uci: playerMoveUci, san: playedSan, cp: playerCp, cpRaw: playerEval.cp, pawns: format.pawns(playerCp) },
            delta_cp: (playerCp - baselineCp),
            delta_pawns: ((playerCp - baselineCp)/100).toFixed(2),
            initial_win_pct: initialWin != null ? initialWin.toFixed(2) : null,
            move_win_pct: moveWin != null ? moveWin.toFixed(2) : null,
            win_change_pct: (initialWin!=null && moveWin!=null) ? (moveWin-initialWin).toFixed(2) : null
          })
          // Expose for quick inspection in the console
          window.__cp_lastEval = { fen: startFEN, isWhiteToMove, bestMoveUci, baselineCp, playerMoveUci, playerCp }
        }catch(e){}
      }

      // Hide spinner after evaluation completes
      hideEvaluatingSpinner();
      
      // Baseline (from precompute) vs player's resulting position — both from mover's perspective
      const json = await sendMoveToServer(baselineCp ?? 0, playerCp);
      // Pass client-evaluated CPs to ensure UI can always show CP change
      handleCheckPuzzleResponse(json, source, target, startFEN, { initialCp: baselineCp ?? 0, moveCp: playerCp });
    } catch(err) {
      console.error('Evaluation or server error:', err);
      hideEvaluatingSpinner();
      if (err.message && err.message.includes('not ready')) {
        setText('info', 'Chess engine not ready. Please wait a moment and try again.');
      } else if (err.message && err.message.includes('failed to evaluate')) {
        setText('info', 'Chess engine failed to analyze this position. Please try again or click Next for a different puzzle.');
      } else {
        setText('info', 'Error analyzing position. Please try again.');
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
    const prev = $('promotionSelector')
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
  }catch(e){ dbg('showPromotionSelector failed', e); try{ cb(null) }catch(e){} }
}

// Display a simple congratulatory modal for new puzzle-streak records
// Show a small toast for new puzzle-streak records (uses same toast container as badges)
function showRecordToast(newBest){
  try{
    const container = $('toastContainer')
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
    const boardEl = $('board')
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
  const hintBtn = $('hint')
  if (hintBtn){
    hintBtn.addEventListener('click', async ()=>{
      try{
        // Block hint if moves are disabled or button is disabled
        if (!allowMoves || hintBtn.disabled) return
        if (!currentPuzzle) return
        // Ask the server for the hint (from-square) so we don't need to expose correct_san
        const r = await fetch('/puzzle_hint', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({id: currentPuzzle.id})})
        if (!r.ok){
          dbg('puzzle_hint failed', r.status)
          return
        }
        const j = await r.json().catch(e=>null)
        if (!j || !j.from) return
        hintUsedForCurrent = true
        // Clear any selected piece so the hint highlight is visible
        clearClickToMoveSelection()
        // keep the hint button enabled so the user can press it again to re-highlight
        hintHighlightSquare(j.from, 3000)
      }catch(e){ dbg('Hint failed', e) }
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
  const move = ((fullMove - 1) * 2) + (side === 'white' ? 1 : 2) -1
  if (!gameId || !move) return
  let container = $('seeOnLichessContainer')
  if (!container){
    // try to place next to Next button
    const nextBtn = $('next')
    if (!nextBtn) return
    container = document.createElement('span')
    container.id = 'seeOnLichessContainer'
    // avoid inline margins; rely on the parent's flex gap for spacing
    container.style.marginLeft = ''
    nextBtn.parentNode.insertBefore(container, nextBtn.nextSibling)
  }
  // create or update link
  let link = $('seeOnLichess')
  const url = `https://lichess.org/${gameId}/${side}#${move}`
  if (!link){
    link = document.createElement('a')
    link.id = 'seeOnLichess'
    // Match the Next button's classes so the appearance is identical
    try{
      const nextBtn2 = $('next')
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

// Show a bootstrap toast listing awarded badges
function showBadgeToast(badges){
  try{
    if (!badges || !badges.length) return
    const container = $('toastContainer')
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
  }catch(e){ dbg('showBadgeToast failed', e) }
}

// Show a small +XP animation near the ribbon XP element
function animateXpIncrement(delta){
  animateRibbonIncrement('ribbonXP', `+${delta} XP`, delta >= 5)
}

/**
 * Generic function to animate value increments near ribbon elements
 * @param {string} elementId - ID of the ribbon element
 * @param {string} text - Text to display in animation (e.g., "+10 XP", "🔥 Streak!")
 * @param {boolean} shouldAnimate - Whether to show animation (allows conditional logic)
 * @param {object} options - Optional styling overrides
 */
function animateRibbonIncrement(elementId, text, shouldAnimate = true, options = {}) {
  if (!shouldAnimate) return
  
  try {
    const targetEl = $(elementId)
    if (!targetEl) return
    
    const rect = targetEl.getBoundingClientRect()
    const el = document.createElement('div')
    el.textContent = text
    
    // Default styles (can be overridden)
    const defaults = {
      position: 'fixed',
      left: (rect.right - 10) + 'px',
      top: (rect.top - 6) + 'px',
      zIndex: 2000,
      fontWeight: '600',
      color: '#28a745',
      transition: 'transform 1000ms ease-out, opacity 1000ms ease-out',
      transform: 'translateY(0px)',
      opacity: '1'
    }
    
    // Apply styles (defaults + overrides)
    Object.assign(el.style, defaults, options)
    document.body.appendChild(el)
    
    // Force layout then animate up and fade
    requestAnimationFrame(() => {
      el.style.transform = 'translateY(-30px)'
      el.style.opacity = '0'
    })
    
    // Cleanup
    setTimeout(() => { 
      try { document.body.removeChild(el) } catch(e) {} 
    }, 1000)
  } catch(e) { 
    /* ignore animation failures */ 
  }
}

// Expose globally for ribbon.js to use
window.animateRibbonIncrement = animateRibbonIncrement

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
  // Load engine preference from cookie and update label
  try {
    const pref = getCookie('sf_engine')
    ENGINE_CHOICE = (pref === 'full' || pref === 'lite') ? pref : 'lite'
    updateEngineDropdownLabel()
  } catch(e) {}
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
    // Block all interactions if moves are disabled (e.g., during animation)
    if (!allowMoves) return
    
    const piece = game.get(square)
    const boardEl = $('board')
    
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
    const boardEl = $('board')
    if (!boardEl) return
    
    let pointerDownSquare = null
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
      const boardEl = $('board')
      if (!boardEl) return
      // allow our CSS max-width to constrain the container while keeping width fluid
      boardEl.style.width = '100%'
      // trigger the chessboard library to resize internal elements
      if (board && typeof board.resize === 'function') board.resize()
    }catch(e){ dbg('resizeBoard failed', e) }
  }
  // debounce helper
  let _rb_to = null
  const scheduleResize = () => { clearTimeout(_rb_to); _rb_to = setTimeout(resizeBoard, 120) }
  // Call once immediately to ensure initial sizing
  scheduleResize()
  // Recompute on window resize and orientation change
  window.addEventListener('resize', scheduleResize, {passive:true})
  window.addEventListener('orientationchange', scheduleResize)
  
  const nextBtn = $('next');
  if (nextBtn) nextBtn.addEventListener('click', loadPuzzle);
  // Engine dropdown bindings
  const menuItems = document.querySelectorAll('[data-engine-choice]')
  menuItems.forEach(a => a.addEventListener('click', (ev) => {
    ev.preventDefault()
    const choice = (ev.currentTarget.getAttribute('data-engine-choice') || '').toLowerCase()
    switchEngine(choice)
  }))
  // ensure Hint button matches Next button styling and initial enabled/disabled state
  const nextBtn2 = $('next')
  const hintBtn2 = $('hint')
  if (nextBtn2 && hintBtn2){
    // copy className to match appearance (keeps margins/spacings consistent)
    hintBtn2.className = nextBtn2.className
    // by default, hint should be enabled only when a puzzle is loaded; disable until loadPuzzle runs
    hintBtn2.disabled = true
  }
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
