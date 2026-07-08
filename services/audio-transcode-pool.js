/*
 * Promise API over a small pool of mulaw-pcm.worker.js threads. Only the Gemini
 * AI-calling engine uses this (OpenAI Realtime is μ-law native → no transcode).
 * Frames round-trip to a worker via TRANSFERABLE ArrayBuffers (no copy), so the
 * shared event loop never does the sample-rate/codec math even at high call
 * volume. Sub-ms IPC per 20 ms frame → imperceptible next to network/model latency.
 *
 * Lazy-started (no workers spawned until the first Gemini call), round-robin,
 * unref'd so the pool can't hold the process open at shutdown.
 */

const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const logger = require('../logger');

const WORKER_PATH = path.join(__dirname, '..', 'workers', 'mulaw-pcm.worker.js');
const POOL_SIZE = Math.max(1, Math.min(4, (os.cpus().length || 2) - 1));

let workers = null;
let rr = 0;
let seq = 0;
const pending = new Map(); // id → { resolve, reject, slot }

// Reject + evict every in-flight request dispatched to a dead worker slot so its
// promises (and the Gemini engine chains that await them) never stall forever.
function failSlot(slot, why) {
  for (const [id, p] of pending) {
    if (p.slot === slot) { pending.delete(id); try { p.reject(new Error(why)); } catch { /* noop */ } }
  }
}

function spawnWorker(slot) {
  const w = new Worker(WORKER_PATH);
  w.on('message', (m) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error));
    else p.resolve(Buffer.from(m.buf));
  });
  // A worker fault must recover, not silently rot: fail its in-flight requests and
  // respawn a replacement in the same slot (else round-robin keeps routing ~1/N of
  // all future frames to a dead worker → unbounded `pending` growth).
  w.on('error', (e) => {
    logger.warn('transcode worker error · slot=' + slot + ' · ' + (e && e.message));
    failSlot(slot, 'transcode worker error');
  });
  w.on('exit', (code) => {
    if (!workers) return; // pool shut down intentionally
    failSlot(slot, 'transcode worker exited (' + code + ')');
    logger.warn('transcode worker exited · slot=' + slot + ' · code=' + code + ' · respawning');
    workers[slot] = spawnWorker(slot);
  });
  if (w.unref) w.unref();
  return w;
}

function ensurePool() {
  if (workers) return;
  workers = [];
  for (let i = 0; i < POOL_SIZE; i += 1) workers[i] = spawnWorker(i);
  logger.info('Audio transcode pool started · workers=' + POOL_SIZE);
}

function run(dir, nodeBuf) {
  ensurePool();
  // Fresh 0-offset ArrayBuffer so the worker's Int16Array view is aligned and the
  // buffer is safely transferable (a Node Buffer often shares a pooled ArrayBuffer).
  const ab = nodeBuf.buffer.slice(nodeBuf.byteOffset, nodeBuf.byteOffset + nodeBuf.byteLength);
  const id = (seq = (seq + 1) % Number.MAX_SAFE_INTEGER);
  const slot = (rr = (rr + 1) % workers.length);
  const w = workers[slot];
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, slot });
    try {
      w.postMessage({ id, dir, buf: ab }, [ab]);
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  });
}

// μ-law 8k Buffer → PCM16 16k Buffer.
function muLawToPcm16k(muLawBuf) { return run('in', muLawBuf); }
// PCM16 24k Buffer → μ-law 8k Buffer.
function pcm24kToMuLaw(pcmBuf) { return run('out', pcmBuf); }

function shutdown() {
  if (!workers) return;
  const ws = workers;
  workers = null; // null FIRST so terminate()'s 'exit' handler doesn't respawn
  for (const w of ws) { try { w.terminate(); } catch { /* noop */ } }
  pending.clear();
}

module.exports = { muLawToPcm16k, pcm24kToMuLaw, shutdown };
