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
        if ((s.total || 0) > 0 && (s.done || 0) >= (s.total || 0)){
          return s
        }
        // If total is zero, still poll until it becomes non-zero or a short timeout
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
    const bs = new bootstrap.Modal(el)
    bs.show()
    return bs
  }

  function hideModal(bs){
    if (!bs) return
    setTimeout(()=> bs.hide(), 1000) // 1 second delay before hiding to show final counts
  }

  function updateModal(progress){
    try{
      document.getElementById('importTotal').textContent = progress.total || '?'
      document.getElementById('importDone').textContent = progress.done || 0
      document.getElementById('importLastGame').textContent = progress.last_game_date || '-'
    }catch(e){}
  }

  async function onUpdateClicked(e){
    const bs = showModal()
    // start import (server will enqueue a Celery task)
    await startImport()
    // poll until done and update modal each poll
    await pollImportUntilDone(updateModal)
    hideModal(bs)
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
        if (s && (s.total || 0) > 0 && (s.done || 0) < (s.total || 0)){
          const bs = showModal()
          pollImportUntilDone(updateModal).then(()=>hideModal(bs))
        }
      }).catch(()=>{})
    }catch(e){}
  }

  window.importer = { startImport, pollImportUntilDone }
  document.addEventListener('DOMContentLoaded', attach)
})()
