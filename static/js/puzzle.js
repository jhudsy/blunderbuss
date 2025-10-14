// Ensure CP_DEBUG exists and silence debug logs in production UI
if (typeof window !== 'undefined') {
  if (typeof window.__CP_DEBUG === 'undefined') window.__CP_DEBUG = false
  if (!window.__CP_DEBUG) { try { console.debug = function(){} } catch(e){} }
}

let board = null
let game = new Chess()
let currentPuzzle = null
let hintUsedForCurrent = false
// result modal removed; use inline UI feedback instead

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
  // clear any square highlights from previous puzzle
  clearAllHighlights()

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
      try{ document.getElementById('next').disabled = true } catch(e){}
      // reset hint state
      hintUsedForCurrent = false
      try{
        const hintBtn = document.getElementById('hint')
        const nextBtn = document.getElementById('next')
        if (hintBtn){
          // mirror Next button styling so the buttons look consistent
          if (nextBtn) hintBtn.className = nextBtn.className
          hintBtn.disabled = false
        }
      } catch(e){}
    // refresh ribbon XP/streak for this user if the ribbon helper is present
    try{ if (window.refreshRibbon) window.refreshRibbon() } catch(e){}
}

  // import-related UI removed
async function onDrop(source, target){
  // guard: ensure we have a loaded puzzle
  // clear any lingering hint highlight immediately when attempting a move
  try{ clearHintHighlights() } catch(e){}
  if (!currentPuzzle){
    if (window.__CP_DEBUG) console.debug('onDrop called before puzzle loaded')
    return 'snapback'
  }

  const move = {from: source, to: target, promotion: 'q'}
  // capture the starting FEN so we can reset after a wrong move
  const startFEN = game.fen()
  const result = game.move(move)
  if (result === null){
    return 'snapback'
  }
  // send SAN to backend
  const san = result.san
  if (window.__CP_DEBUG) console.debug('starting fen', startFEN)
  if (window.__CP_DEBUG) console.debug('check_puzzle: sending', { puzzleId: currentPuzzle && currentPuzzle.id, san })

  try{
    const r = await fetch('/check_puzzle', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({id: currentPuzzle.id, san, hint_used: hintUsedForCurrent})})
    if (window.__CP_DEBUG) console.debug('check_puzzle: raw response', r)
    if (!r.ok){
      const t = await r.text().catch(e => '<no-body>')
      console.error('check_puzzle: non-OK response', r.status, t)
      throw new Error('check_puzzle non-OK: ' + r.status)
    }
    const j = await r.json().catch(e => { console.error('check_puzzle: JSON parse error', e); throw e })
    if (window.__CP_DEBUG) console.debug('check_puzzle: response', j)
    try{ if (window.__CP_DEBUG) console.debug('check_puzzle: response keys', Object.keys(j), 'stringified', JSON.stringify(j)) } catch(e){}

    if (j.correct){
      highlightSquareWithFade(source, 'green')
      highlightSquareWithFade(target, 'green')
      // brief inline feedback instead of modal
      const infoEl = document.getElementById('info')
      if (infoEl) infoEl.textContent = 'Correct! Click Next to continue.'
      // update ribbon XP immediately from server response if present
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
      // refresh full ribbon state from server
      try{ if (window.refreshRibbon) window.refreshRibbon() } catch(e){}
      // enable Next after a short delay
  setTimeout(()=>{ document.getElementById('next').disabled = false }, 800)
  // disable Hint after an answer is given; it will be re-enabled on next puzzle load
  try{ const hintBtn = document.getElementById('hint'); if (hintBtn) hintBtn.disabled = true } catch(e){}
      // show badge modal only if new badges were awarded on this answer
      if (j.awarded_badges && j.awarded_badges.length){
        // show inline toast for new badges
        showBadgeToast(j.awarded_badges)
      }
      // Show congratulatory toast if the server reports a new record streak
      try{
        if (j.new_record_streak){
          try{ showRecordToast(j.new_record_streak) } catch(e){ try{ alert('New record! Streak: ' + j.new_record_streak) }catch(e){} }
        }
      }catch(e){}
      // reveal 'See on lichess' link if we have game info
      try{ showSeeOnLichessLink(currentPuzzle) } catch(e){}
    } else {
      if (window.__CP_DEBUG) console.debug('check_puzzle: incorrect branch entered', { startFEN })
      // Orchestrate the reveal sequence for an incorrect answer (visual only)
      highlightSquareWithFade(source, 'red')
      highlightSquareWithFade(target, 'red')

      // Start reveal sequence using nested setTimeouts (avoid async/await so logs always run)
      setTimeout(() => {
        // 1) after brief pause, reset board to the starting position (don't mutate global game yet)
        try { if (window.__CP_DEBUG) console.log('here'); board.position(startFEN) } catch (e) { console.error('Error resetting board position:', e) }

        // 2) wait a little more before revealing the correct move
        setTimeout(() => {
          // 3) reveal correct move if provided
          if (window.__CP_DEBUG) console.debug('check_puzzle: hasOwnProperty(correct_san)?', j && Object.prototype.hasOwnProperty.call(j, 'correct_san'))
          if (window.__CP_DEBUG) console.debug('check_puzzle: typeof correct_san', typeof j.correct_san, 'value:', j.correct_san)
          if (j.correct_san){
            if (window.__CP_DEBUG) console.debug('server provided correct_san (raw):', j.correct_san)
            const cmc = document.getElementById('correctMoveContainer')
            if (cmc) cmc.style.display = ''
            // sanitize SAN from server (strip stray punctuation or leading move numbers)
            let san = (j.correct_san || '').toString().trim()
            if (window.__CP_DEBUG) console.debug('server provided correct_san (before sanitize):', j.correct_san, 'after trim:', san)
            san = san.replace(/^\d+\.*\s*/, '')
            san = san.replace(/\.{2,}/g, '')
            san = san.replace(/[(),;:]/g, '')
            san = san.trim()
            if (window.__CP_DEBUG) console.debug('server provided correct_san (sanitized):', san)
            try{
              // compute the correct move from the starting position using a temp Chess instance
              const temp = new Chess()
              try{ temp.load(startFEN) } catch(e){ /* ignore */ }
              const moveObj = temp.move(san, {sloppy: true})
              if (window.__CP_DEBUG) console.debug('temp.move result:', moveObj)
              if (moveObj){
                try{ revealCorrectMoveSquares(moveObj.from, moveObj.to) } catch(e){}
              } else {
                const moves = temp.moves({verbose:true})
                for (let m of moves){
                  if (m.san === san){
                    if (window.__CP_DEBUG) console.debug('matched move in moves list:', m)
                    try{ revealCorrectMoveSquares(m.from, m.to) } catch(e){ board.position(startFEN) }
                    break
                  }
                }
                if (window.__CP_DEBUG) console.debug('fallback scan complete, no direct temp.move result')
              }
              // ensure the global game is reset back to the starting position after reveal
              try{ game.load(startFEN) } catch(e){ /* ignore */ }
            }catch(e){ /* ignore reveal failures */ }
          }
          // show badges if any
          if (j.awarded_badges && j.awarded_badges.length){
            showBadgeToast(j.awarded_badges)
          }
          // 4) inline feedback and re-enable Next after delay (no modal)
          const infoEl2 = document.getElementById('info')
          if (infoEl2) infoEl2.textContent = 'Incorrect — the correct move is shown on the board. Click Next to continue.'
          // update ribbon XP immediately if provided
          try{
            if (typeof j.xp !== 'undefined'){
              const rx2 = document.getElementById('ribbonXP')
              if (rx2){
                const prev2 = parseInt(rx2.textContent) || 0
                rx2.textContent = j.xp
                const delta2 = (j.xp || 0) - prev2
                if (delta2 > 0) animateXpIncrement(delta2)
              }
            }
          }catch(e){}
          // refresh ribbon from backend to get full state (streak etc.)
          try{ if (window.refreshRibbon) window.refreshRibbon() } catch(e){}
          setTimeout(()=>{ document.getElementById('next').disabled = false }, 800)
          // disable Hint after an incorrect attempt as well
          try{ const hintBtn = document.getElementById('hint'); if (hintBtn) hintBtn.disabled = true } catch(e){}
          // reveal 'See on lichess' link if we have game info
          try{ showSeeOnLichessLink(currentPuzzle) } catch(e){}
        }, 250)
      }, 800)
    }
  }catch(err){
    console.error('check_puzzle: async error', err)
  }
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
    const bs = new bootstrap.Toast(toastEl, { delay: 5000 })
    bs.show()
    toastEl.addEventListener('hidden.bs.toast', ()=>{ try{ container.removeChild(toastEl) }catch(e){} })
  }catch(e){ try{ alert('Congratulations! New record puzzle streak: ' + String(newBest)) }catch(e){} }
}

// remove only hint (blue) highlight classes
function clearHintHighlights(){
  try{
    const els = document.querySelectorAll('.square-highlight-blue')
    els.forEach(el=>{ try{ el.classList.remove('square-highlight-blue') }catch(e){} })
  }catch(e){}
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
    toastEl.setAttribute('aria-atomic','true')
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
      const bs = new bootstrap.Toast(toastEl, { delay: 5000 })
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
  els.forEach(el=>{ el.classList.remove('square-highlight-green','square-highlight-red'); el.style.background = '' })
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
function revealCorrectMoveSquares(from, to){
  try{
    // animate the move using chessboard.js
    try { board.move(from + '-' + to) } catch(e) { /* ignore animation failure */ }
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

window.addEventListener('DOMContentLoaded', ()=>{
  // create the board once with our local pieceTheme
  // clear hint when user begins interacting with the board (onDragStart)
  board = Chessboard('board', {position: 'start', draggable: true, onDrop, onDragStart: ()=>{ try{ clearHintHighlights() }catch(e){} }, pieceTheme: '/static/img/chesspieces/{piece}.png'})
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
  // Ensure pointer/touch interactions clear the hint immediately for mobile/touch users
  try{
    const boardEl = document.getElementById('board')
    if (boardEl){
  // Use pointer events only (covers mouse and touch on modern browsers)
  boardEl.addEventListener('pointerdown', ()=>{ try{ clearHintHighlights() }catch(e){} }, {passive:true})
    }
  }catch(e){}
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
