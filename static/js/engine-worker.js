/* Web Worker wrapper for Stockfish 17.1 Lite WASM */

// Ensure WASM files are loaded from the correct directory regardless of worker origin
self.Module = self.Module || {};
self.Module.locateFile = function(path) {
  // The stockfish JS will request its .wasm by name; point to vendor dir
  return '/static/vendor/stockfish/' + path;
};

// Load the Stockfish 17.1 Lite JS glue (will fetch corresponding .wasm)
importScripts('/static/vendor/stockfish/stockfish-17.1-lite-51f59da.js');

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
