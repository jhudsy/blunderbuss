// Reusable ribbon helper: exposes initRibbon() and refreshRibbon()
(function(){
  async function refreshRibbon(){
    try{
  const elXP = document.getElementById('ribbonXP')
  const elDays = document.getElementById('ribbonDaysStreak')
  const elPuzzle = document.getElementById('ribbonPuzzleStreak')
      const elUser = document.getElementById('ribbonUsername')
      const elAuth = document.getElementById('ribbonAuth')
      // If ribbon elements are not present, do nothing (makes this file safe to include everywhere)
  if (!elXP && !elDays && !elPuzzle && !elUser && !elAuth) return
      const r = await fetch('/user_information', { credentials: 'same-origin' })
      if (!r.ok){
        if (elXP) elXP.textContent = '-'
        if (elDays) elDays.textContent = '-'
        if (elUser) elUser.textContent = 'Not signed in'
        if (elAuth) { elAuth.href = '/login'; elAuth.textContent = 'Login' }
        return
      }
      const j = await r.json()
      if (elXP) elXP.textContent = j.xp || 0
      if (elDays) elDays.textContent = j.streak || 0
      // badge count (if API returns badges list)
      try{
        const bc = document.getElementById('ribbonBadgeCount')
        if (bc){
          const badges = (j.badges || [])
          const count = badges.length || 0
          bc.textContent = count
          // Build a compact tooltip: show count and up to two truncated badge names
          try{
            if (count === 0){
              bc.removeAttribute('title')
              bc.removeAttribute('aria-label')
            } else {
              const maxNames = 2
              const names = badges.slice(0, maxNames).map(n => {
                // truncate long names to 20 chars
                const s = String(n || '')
                return s.length > 20 ? (s.slice(0,17) + '...') : s
              })
              const more = count > maxNames ? ` +${count - maxNames} more` : ''
              const title = `${count} badge${count !== 1 ? 's' : ''} — ${names.join(', ')}${more}`
              bc.setAttribute('title', title)
              bc.setAttribute('aria-label', title)
            }
          }catch(e){
            // ignore tooltip failures; don't block ribbon update
            if (window.__CP_DEBUG) console.debug('badge tooltip build failed', e)
          }
        }
      }catch(e){}
      // Puzzle streak may be animated when it increases; detect increase and
      // briefly add an animated class.
      if (elPuzzle){
        const prev = parseInt(elPuzzle.getAttribute('data-prev') || '0', 10)
        const now = parseInt(j.puzzle_streak || 0, 10)
        const best = parseInt(j.best_puzzle_streak || 0, 10)
        // display current streak and best in brackets if best present
        elPuzzle.textContent = now + (best ? ` (${best})` : '')
        elPuzzle.setAttribute('data-prev', String(now))
        if (now > prev){
          elPuzzle.classList.add('ribbon-pulse')
          setTimeout(()=>elPuzzle.classList.remove('ribbon-pulse'), 900)
        }
      }
      if (elUser) {
        // prefer a templated session username if present on the page
        try{
          const sess = window._session_username || null
          elUser.textContent = sess || (j.username || 'User')
        }catch(e){ elUser.textContent = (j.username || 'User') }
      }
      if (elAuth) { elAuth.href = '/logout'; elAuth.textContent = 'Logout' }
    }catch(e){
      // don't throw; ribbon is non-critical
      if (window.__CP_DEBUG) console.debug('refreshRibbon failed', e)
    }
  }

  function initRibbon(){
    // initial population
    refreshRibbon()
    // Also ensure importer attach is called in case ribbon.js is loaded after importer
    try{ if (window.importer && typeof window.importer.startImport === 'function') { /* importer will attach on DOMContentLoaded */ } }catch(e){}
    // expose for other code to call when needed
    window.refreshRibbon = refreshRibbon
    window.initRibbon = initRibbon
  }

  // attach to global so pages can call initRibbon() after DOM is ready
  window.refreshRibbon = refreshRibbon
  window.initRibbon = initRibbon
})();
