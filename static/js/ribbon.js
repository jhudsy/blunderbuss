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
        if (elStreak) elStreak.textContent = '-'
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
        if (bc) bc.textContent = (j.badges || []).length || 0
      }catch(e){}
      // Puzzle streak may be animated when it increases; detect increase and
      // briefly add an animated class.
      if (elPuzzle){
        const prev = parseInt(elPuzzle.getAttribute('data-prev') || '0', 10)
        const now = parseInt(j.puzzle_streak || 0, 10)
        elPuzzle.textContent = now
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
    // expose for other code to call when needed
    window.refreshRibbon = refreshRibbon
    window.initRibbon = initRibbon
  }

  // attach to global so pages can call initRibbon() after DOM is ready
  window.refreshRibbon = refreshRibbon
  window.initRibbon = initRibbon
})();
