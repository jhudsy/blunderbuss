/* Web Worker wrapper for Stockfish 17.1 Lite WASM */

// Ensure WASM files are loaded from the correct directory regardless of worker origin
self.Module = self.Module || {};
self.Module.locateFile = function(path) {
  // The stockfish JS will request its .wasm by name; point to our dedicated asset route
  return '/assets/stockfish/' + path;
};
// Help Emscripten resolve paths correctly inside a wrapper worker
self.Module.mainScriptUrlOrBlob = '/assets/stockfish/stockfish-17.1-lite-51f59da.js';
// Explicitly set the wasm binary path for the lite build
self.Module.wasmBinaryFile = '/assets/stockfish/stockfish-17.1-lite-51f59da.wasm';

// Debug: capture all fetches from the glue code to identify incorrect URLs
try {
  const __origFetch = self.fetch;
  self.fetch = function(url, options){
    try { self.postMessage('DEBUG_FETCH ' + url); } catch(e){}
    try {
      return __origFetch(url, options).then(r => {
        try {
          const ct = r && r.headers ? r.headers.get('content-type') : null
          self.postMessage('DEBUG_FETCH_STATUS ' + url + ' ' + (r && r.status) + ' ' + (ct || ''))
        } catch(e){}
        return r
      })
    } catch(e) {
      return __origFetch(url, options)
    }
  }
} catch(e) { /* ignore */ }

// Load the Stockfish 17.1 Lite JS glue (will fetch corresponding .wasm)
importScripts('/assets/stockfish/stockfish-17.1-lite-51f59da.js');

// Instantiate engine
let engine = null;
if (typeof Stockfish === 'function') {
  engine = Stockfish();
  // Forward engine messages to main thread
  engine.onmessage = function(msg) {
    try { self.postMessage(msg); } catch(e) { /* ignore */ }
  };
} else {
  // Report loading error back to main thread
  try { self.postMessage('ERROR: Stockfish 17.1 Lite failed to load'); } catch(e) {}
}

// Forward messages from main thread to engine
self.onmessage = function(e) {
  if (!engine) return;
  try { engine.postMessage(e.data); } catch(err) { /* ignore */ }
};
