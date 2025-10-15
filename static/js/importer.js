// Handles starting an import and polling progress to update the modal
(function(){
  async function startImport(){
    try{
      const res = await fetch('/start_import', { method: 'POST', credentials: 'same-origin' })
      if (!res.ok){
        console.warn('Failed to start import', res.status)
        return null
      }
      const j = await res.json()
      return j.task_id || null
    }catch(e){
      console.warn('startImport error', e)
      return null
    }
  }

  async function pollImportUntilDone(onUpdate){
    try{
      while(true){
        const r = await fetch('/import_status', { credentials: 'same-origin' })
        if (!r.ok) return null
        const s = await r.json()
        if (typeof onUpdate === 'function') onUpdate(s)
        // Completion condition: backend returns status 'finished' when worker is done.
        const status = (s.status || 'idle')
        if (status === 'finished'){
          return s
        }
        if (status === 'failed'){
          // update modal once more to show error and treat as terminal
          try{
            const el = document.getElementById('importSpinner')
            if (el) el.innerHTML = '<div class="text-danger">Import failed</div>'
            const last = document.getElementById('importLastGame')
            if (last && s.error) last.textContent = s.error
          }catch(e){}
          return s
        }
        // wait a short interval before polling again
        await new Promise(res => setTimeout(res, 800))
      }
    }catch(e){
      console.warn('pollImportUntilDone error', e)
      return null
    }
  }

  function showModal(){
    const el = document.getElementById('importModal')
    if (!el) return
    // Use existing instance if present to avoid multiple backdrops
    const existing = bootstrap.Modal.getInstance(el)
    const bs = existing || new bootstrap.Modal(el)
    bs.show()
    return bs
  }

  function hideModal(bs){
    if (!bs) return
    // hide then dispose to ensure any backdrop elements are removed
    setTimeout(()=>{
      try{ bs.hide() }catch(e){}
      // dispose after a short delay to allow hide animation to finish
      setTimeout(()=>{ try{ bs.dispose() }catch(e){} }, 300)
    }, 1000) // 1 second delay before hiding to show final counts
  }

  function updateModal(progress){
    try{
      document.getElementById('importDone').textContent = progress.done || 0
      document.getElementById('importLastGame').textContent = progress.last_game_date || '-'    
    }catch(e){}
  }

  async function onUpdateClicked(e){
    const bs = showModal()
    // start import (server will enqueue a Celery task)
    await startImport()
    // poll until done and update modal each poll
    const final = await pollImportUntilDone(updateModal)
    hideModal(bs)
    // After the import finishes, load a puzzle so the UI doesn't remain on
    // the default starting board. Use a short delay to allow the modal hide
    // animation to complete.
    try{
      if (final && final.status !== 'failed'){
        if (typeof window.loadPuzzle === 'function') setTimeout(()=>{ try{ window.loadPuzzle() }catch(e){} }, 600)
        else setTimeout(()=>{ try{ window.location.reload() }catch(e){} }, 600)
      }
    }catch(e){}
  }

  function attach(){
    const btn = document.getElementById('ribbonUpdatePuzzles')
    if (btn){
      btn.addEventListener('click', onUpdateClicked)
    }
    // Also show modal on page load if we just logged in; start polling automatically
    try{
      // If the server indicated an import is in-progress (total>0 && done<total), show modal and poll
      fetch('/import_status', { credentials: 'same-origin' }).then(r=>r.ok?r.json():null).then(s=>{
        if (s && (s.status || 'idle') === 'in_progress'){
          const bs = showModal()
          // Poll until done; when finished, hide the modal and load a puzzle
          pollImportUntilDone(updateModal).then((final)=>{
            hideModal(bs)
            try{
              if (final && final.status !== 'failed'){
                if (typeof window.loadPuzzle === 'function') setTimeout(()=>{ try{ window.loadPuzzle() }catch(e){} }, 600)
                else setTimeout(()=>{ try{ window.location.reload() }catch(e){} }, 600)
              }
            }catch(e){}
          })
        }
      }).catch(()=>{})
    }catch(e){}
  }

  window.importer = { startImport, pollImportUntilDone }
  document.addEventListener('DOMContentLoaded', attach)
})()
