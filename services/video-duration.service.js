/*
 * ─── TRAINING VIDEO DURATION, READ FROM THE FILE ITSELF ─────────────────
 *
 * probeVideoDuration(url) → whole seconds, or null. Never throws.
 *
 * The watch-time cap (mobile-profile-extra.service::setTrainingPercentage)
 * needs training_videos.duration_seconds, and an operator typing it in was
 * owner-rejected: it is filled from the video instead. Callers are in
 * lms.service (refreshVideoDuration); they pass only a URL built from our own
 * `document` row by normalizeVideoUrl — never anything a client sent.
 *
 * MP4/MOV: an ISO-BMFF file is a flat list of boxes; `moov` holds `mvhd`,
 * whose duration / timescale is the length. We fetch the first 512 KB with a
 * Range request and WALK the top-level boxes. A fast-start file has moov right
 * there. A camera/export file has moov after a huge `mdat`; the walk tells us
 * exactly where that box ends, so the second Range request starts at moov
 * rather than guessing "the last 2 MB" (no HEAD or file size needed). At most
 * three ranged requests. A server that ignores Range (200 + full body) is read
 * for 3 MB and then cut off.
 *
 * YouTube: null. There is no API key and scraping the page is out of scope.
 *
 * SSRF: no helper existed in this repo, so the guard is here. Only http(s);
 * at most 3 redirects, each re-checked; and every connection's DNS answer is
 * checked IN the socket's lookup, so the address that is vetted is the one
 * connected to (no rebinding window). Private, loopback, link-local, CGNAT
 * and multicast addresses are refused unless the host is in `trustedHosts` —
 * the caller passes our own document host (lms.service TRAINING_VIDEO_HOST),
 * which is allowed even if it resolves privately inside our network.
 */
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const logger = require('../logger');

const HEAD_BYTES = 512 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_RANGE_REQUESTS = 3;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
const MAX_SECONDS = 86_400;
const YOUTUBE_HOST = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;

const PRIVATE = new net.BlockList();
for (const [a, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3]]) {
  PRIVATE.addSubnet(a, bits, 'ipv4');
}
for (const [a, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  PRIVATE.addSubnet(a, bits, 'ipv6');
}

function isPrivateIp(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return PRIVATE.check(mapped[1], 'ipv4');
  const family = net.isIP(ip);
  return family === 0 ? true : PRIVATE.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

// ─── ISO-BMFF ───────────────────────────────────────────────────────────

// Returns seconds, null (not a readable movie), or undefined (no mvhd before `end`).
function mvhdSeconds(buf, start, end) {
  let p = start;
  while (p + 8 <= end) {
    const size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'mvhd') {
      const version = p + 9 <= end ? buf[p + 8] : undefined;
      const need = version === 1 ? 40 : 28;
      if (version === undefined || p + need > end) return undefined;
      const [timescale, duration] = version === 1
        ? [buf.readUInt32BE(p + 28), Number(buf.readBigUInt64BE(p + 32))]
        : [buf.readUInt32BE(p + 20), buf.readUInt32BE(p + 24)];
      if (version > 1 || !timescale || duration === 0xFFFFFFFF) return null;
      const seconds = Math.round(duration / timescale);
      return seconds >= 1 && seconds <= MAX_SECONDS ? seconds : null;
    }
    if (size < 8) return null;
    p += size;
  }
  return undefined; // the caller knows whether moov was cut short
}

/*
 * Walk the top-level boxes of `buf`, which holds the file from offset `base`.
 * Returns seconds, null (garbage / no moov), or { next } — the file offset
 * where the walk must continue.
 */
function walkBoxes(buf, base = 0) {
  let p = 0;
  while (p + 8 <= buf.length) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (!/^[\x20-\x7e]{4}$/.test(type)) return null;
    let header = 8;
    if (size === 1) {
      if (p + 16 > buf.length) return { next: base + p };
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) {
      size = Infinity; // runs to end of file
    }
    if (size < header) return null;
    if (type === 'moov') {
      const end = Math.min(buf.length, p + size);
      const s = mvhdSeconds(buf, p + header, end);
      if (s !== undefined) return s;
      return end < p + size ? { next: base + p } : null;
    }
    if (size === Infinity) return null;
    p += size;
  }
  return { next: base + p };
}

// Whole file (or its head) in memory → seconds or null.
function parseMp4Duration(buf) {
  const r = walkBoxes(buf, 0);
  return typeof r === 'number' ? r : null;
}

// ─── HTTP ───────────────────────────────────────────────────────────────

function guardedLookup(trusted) {
  return (hostname, options, cb) => {
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return cb(err);
      const list = Array.isArray(address) ? address.map((a) => a.address) : [address];
      if (!trusted.has(hostname.toLowerCase()) && list.some(isPrivateIp)) {
        return cb(Object.assign(new Error(`refusing private address for ${hostname}`), { code: 'EPRIVATE' }));
      }
      return cb(null, address, family);
    });
  };
}

function get(url, start, length, ctx, hops = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('not http(s): ' + u.protocol));
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (net.isIP(host) && !ctx.trusted.has(host) && isPrivateIp(host)) {
      return reject(new Error('refusing private address ' + host));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, {
      headers: { Range: `bytes=${start}-${start + length - 1}`, 'User-Agent': 'EasyFix-duration-probe' },
      lookup: guardedLookup(ctx.trusted),
    }, (res) => {
      const { statusCode: status, headers } = res;
      if ([301, 302, 303, 307, 308].includes(status) && headers.location) {
        res.resume();
        clearTimeout(timer);
        if (hops >= MAX_REDIRECTS) return reject(new Error('too many redirects'));
        return resolve(get(new URL(headers.location, u).toString(), start, length, ctx, hops + 1));
      }
      if (status !== 200 && status !== 206) {
        res.resume();
        clearTimeout(timer);
        return reject(new Error('HTTP ' + status));
      }
      // 200 = Range ignored: the body is the whole file, so read only a capped prefix.
      const cap = status === 206 ? length : MAX_BODY_BYTES;
      const chunks = [];
      let got = 0;
      const done = () => {
        clearTimeout(timer);
        const total = /\/(\d+)\s*$/.exec(headers['content-range'] || '');
        resolve({ status, body: Buffer.concat(chunks).subarray(0, cap), total: total ? Number(total[1]) : null });
      };
      res.on('data', (c) => {
        chunks.push(c);
        got += c.length;
        if (got >= cap) { res.removeAllListeners('data'); res.destroy(); done(); }
      });
      res.on('end', done);
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    const timer = setTimeout(() => req.destroy(new Error('timed out')), Math.max(1, ctx.deadline - Date.now()));
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

let _youtubeLogged = false;

async function probeVideoDuration(url, { trustedHosts = [], timeoutMs = TIMEOUT_MS } = {}) {
  try {
    const u = new URL(String(url || ''));
    if (YOUTUBE_HOST.test(u.hostname)) {
      if (!_youtubeLogged) {
        _youtubeLogged = true;
        logger.info('Video duration: YouTube links are not probed (no API key) — duration stays unknown');
      }
      return null;
    }
    const ctx = {
      deadline: Date.now() + timeoutMs,
      trusted: new Set(trustedHosts.map((h) => String(h).toLowerCase())),
    };
    let r = await get(u.toString(), 0, HEAD_BYTES, ctx);
    let found = walkBoxes(r.body, 0);
    const total = r.total;
    // Range ignored: we hold a capped prefix and cannot seek, so it is that or nothing.
    for (let n = 1; r.status === 206 && found && typeof found === 'object' && n < MAX_RANGE_REQUESTS; n++) {
      const at = found.next;
      if (total != null && at >= total) break;
      r = await get(u.toString(), at, TAIL_BYTES, ctx);
      if (r.status !== 206) break;
      found = walkBoxes(r.body, at);
      if (found && typeof found === 'object' && found.next <= at) break; // no progress
    }
    if (typeof found === 'number') return found;
    logger.warn('Video duration: no mvhd found · url=' + u.toString());
    return null;
  } catch (e) {
    logger.warn('Video duration probe failed · url=' + url + ' · ' + e.message);
    return null;
  }
}

module.exports = { probeVideoDuration, parseMp4Duration, isPrivateIp };
