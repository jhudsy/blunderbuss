/* Web Worker wrapper for Stockfish 17.1 WASM (Lite or Full) */

// Parse URL parameters to determine which engine to load
const urlParams = new URLSearchParams(self.location.search);
const engineType = urlParams.get('engine') || 'lite'; // 'lite' or 'full'

// Engine-specific configuration
const engineConfig = {
  lite: {
    script: '/static/vendor/stockfish/stockfish-17.1-lite-51f59da.js',
    wasm: '/static/vendor/stockfish/stockfish-17.1-lite-51f59da.wasm',
    name: 'Stockfish 17.1 Lite'
  },
  full: {
    script: '/static/vendor/stockfish/stockfish-17.1-8e4d048.js',
    wasm: null, // Full version uses multi-part loading, no single wasm file
    name: 'Stockfish 17.1 Full'
  }
};

const config = engineConfig[engineType] || engineConfig.lite;

// Ensure WASM files are loaded from the correct directory regardless of worker origin
self.Module = self.Module || {};
self.Module.locateFile = function(path) {
  // The stockfish JS will request its .wasm or part files by name; point to our dedicated asset route
  return '/static/vendor/stockfish/' + path;
};
// Help Emscripten resolve paths correctly inside a wrapper worker
self.Module.mainScriptUrlOrBlob = config.script;
// Explicitly set the wasm binary path for the lite build
if (config.wasm) {
  self.Module.wasmBinaryFile = config.wasm;
}

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

// Load the appropriate Stockfish JS glue
importScripts(config.script);

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
  try { self.postMessage('ERROR: ' + config.name + ' failed to load'); } catch(e) {}
}

// Forward messages from main thread to engine
self.onmessage = function(e) {
  if (!engine) return;
  try { engine.postMessage(e.data); } catch(err) { /* ignore */ }
};
