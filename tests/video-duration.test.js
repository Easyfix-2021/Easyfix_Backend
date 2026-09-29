/*
 * services/video-duration.service.js — the MP4/MOV duration probe behind
 * training_videos.duration_seconds. Synthetic ISO-BMFF buffers, served by an
 * in-process HTTP server on 127.0.0.1 (no network).
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { probeVideoDuration, parseMp4Duration, isPrivateIp } = require('../services/video-duration.service');

// ─── Synthetic files ─────────────────────────────────────────────────

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const box = (type, ...parts) => {
  const payload = Buffer.concat(parts);
  return Buffer.concat([u32(8 + payload.length), Buffer.from(type, 'latin1'), payload]);
};
const ftyp = () => box('ftyp', Buffer.from('isom'), u32(512), Buffer.from('isomiso2avc1mp41'));
// version/flags, creation, modification, timescale, duration, then rate..next_track_id (80 bytes).
const mvhd0 = (timescale, duration) => box('mvhd', u32(0), u32(0), u32(0), u32(timescale), u32(duration), Buffer.alloc(80));
const mvhd1 = (timescale, duration) => box('mvhd', u32(0x01000000), u64(0), u64(0), u32(timescale), u64(duration), Buffer.alloc(80));
const moov = (mvhd) => box('moov', mvhd, box('trak', Buffer.alloc(64)));
const mdat = (bytes) => box('mdat', Buffer.alloc(bytes, 0xab));

const FAST_START = Buffer.concat([ftyp(), moov(mvhd0(1000, 52_000)), mdat(700 * 1024)]);
const MOOV_AT_END = Buffer.concat([ftyp(), mdat(900 * 1024), moov(mvhd0(600, 600 * 125))]);

// ─── Parser ──────────────────────────────────────────────────────────

test('parser: mvhd v0 — 52 s at timescale 1000', () => {
  assert.equal(parseMp4Duration(Buffer.concat([ftyp(), moov(mvhd0(1000, 52_000))])), 52);
});

test('parser: mvhd v1 — a 64-bit duration (4000 s at timescale 10,000,000)', () => {
  // 4e10 does not fit in 32 bits: reading only the low word gives a wrong answer.
  assert.equal(parseMp4Duration(Buffer.concat([ftyp(), moov(mvhd1(10_000_000, 40_000_000_000))])), 4000);
});

test('parser: moov after mdat is found by walking the boxes', () => {
  assert.equal(parseMp4Duration(MOOV_AT_END), 125);
});

test('parser: garbage and degenerate files return null', () => {
  assert.equal(parseMp4Duration(Buffer.from('<html><body>404 Not Found</body></html>')), null);
  assert.equal(parseMp4Duration(Buffer.alloc(0)), null);
  assert.equal(parseMp4Duration(Buffer.alloc(64)), null); // size 0 box of type \0\0\0\0
  assert.equal(parseMp4Duration(Buffer.concat([ftyp(), mdat(16)])), null); // no moov
  assert.equal(parseMp4Duration(Buffer.concat([ftyp(), moov(mvhd0(0, 52_000))])), null); // timescale 0
  assert.equal(parseMp4Duration(Buffer.concat([ftyp(), moov(mvhd0(1000, 0xFFFFFFFF))])), null); // unknown
  assert.equal(parseMp4Duration(Buffer.concat([ftyp(), moov(box('trak', Buffer.alloc(8)))])), null); // no mvhd
});

// ─── HTTP / Range ────────────────────────────────────────────────────

const servers = [];
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } });

async function serve(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => { seen.push({ url: req.url, range: req.headers.range }); handler(req, res); });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  servers.push(srv);
  return { seen, base: `http://127.0.0.1:${srv.address().port}` };
}

function ranged(file) {
  return (req, res) => {
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!m) { res.writeHead(200, { 'content-length': file.length }); return res.end(file); }
    const start = Number(m[1]);
    if (start >= file.length) { res.writeHead(416); return res.end(); }
    const end = Math.min(Number(m[2]), file.length - 1);
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${file.length}`, 'content-length': end - start + 1 });
    res.end(file.subarray(start, end + 1));
  };
}

const TRUST = { trustedHosts: ['127.0.0.1'] };

test('range: moov in the first chunk → exactly one request', async () => {
  const { seen, base } = await serve(ranged(FAST_START));
  assert.equal(await probeVideoDuration(base + '/a.mp4', TRUST), 52);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].range, 'bytes=0-524287');
});

test('range: moov at the end → a second request starting exactly at moov', async () => {
  const { seen, base } = await serve(ranged(MOOV_AT_END));
  assert.equal(await probeVideoDuration(base + '/b.mp4', TRUST), 125);
  assert.equal(seen.length, 2);
  const moovAt = ftyp().length + 8 + 900 * 1024;
  assert.match(seen[1].range, new RegExp(`^bytes=${moovAt}-`));
});

test('range: a server that ignores Range is read for at most 3 MB, then cut off (fail soft)', async () => {
  let finished = null;
  let written = 0;
  const { base } = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4' });
    res.on('close', () => { finished = res.writableFinished; });
    const chunk = Buffer.alloc(64 * 1024, 0xab);
    chunk.writeUInt32BE(0x7fffffff, 0); chunk.write('mdat', 4, 'latin1'); // one huge box, never a moov
    const pump = () => {
      while (written < 50 * 1024 * 1024) {
        written += chunk.length;
        if (!res.write(chunk)) return res.once('drain', pump);
      }
      res.end();
    };
    pump();
  });
  assert.equal(await probeVideoDuration(base + '/c.mp4', TRUST), null);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(finished, false, 'the client hung up before the 50 MB body finished');
  assert.ok(written < 20 * 1024 * 1024, 'wrote ' + written);
});

test('range: a Range-ignoring server still yields the duration when moov is in the capped prefix', async () => {
  const { seen, base } = await serve((req, res) => { res.writeHead(200); res.end(FAST_START); });
  assert.equal(await probeVideoDuration(base + '/d.mp4', TRUST), 52);
  assert.equal(seen.length, 1);
});

test('range: a timeout returns null', async () => {
  const { base } = await serve(() => { /* never answers */ });
  const t0 = Date.now();
  assert.equal(await probeVideoDuration(base + '/e.mp4', { ...TRUST, timeoutMs: 200 }), null);
  assert.ok(Date.now() - t0 < 2000);
});

test('range: an HTTP error or a refused connection returns null', async () => {
  const { base } = await serve((req, res) => { res.writeHead(404); res.end('nope'); });
  assert.equal(await probeVideoDuration(base + '/f.mp4', TRUST), null);
  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const port = dead.address().port;
  await new Promise((r) => dead.close(r));
  assert.equal(await probeVideoDuration(`http://127.0.0.1:${port}/g.mp4`, TRUST), null);
  assert.equal(await probeVideoDuration('not a url'), null);
  assert.equal(await probeVideoDuration('ftp://127.0.0.1/x.mp4', TRUST), null);
});

test('redirects are followed (bounded)', async () => {
  const file = ranged(FAST_START);
  const { seen, base } = await serve((req, res) => {
    if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end(); }
    if (req.url === '/old.mp4') { res.writeHead(301, { location: '/new.mp4' }); return res.end(); }
    return file(req, res);
  });
  assert.equal(await probeVideoDuration(base + '/old.mp4', TRUST), 52);
  assert.deepEqual(seen.map((s) => s.url), ['/old.mp4', '/new.mp4']);
  seen.length = 0;
  assert.equal(await probeVideoDuration(base + '/loop', TRUST), null);
  assert.equal(seen.length, 4, 'the first request plus 3 redirects, then it stops');
});

// ─── YouTube and SSRF ────────────────────────────────────────────────

test('YouTube links return null without a request', async () => {
  assert.equal(await probeVideoDuration('https://www.youtube.com/watch?v=abc12345678'), null);
  assert.equal(await probeVideoDuration('https://youtu.be/abc12345678'), null);
});

test('SSRF: a loopback/private address is refused unless its host is trusted', async () => {
  const { seen, base } = await serve(ranged(FAST_START));
  assert.equal(await probeVideoDuration(base + '/h.mp4'), null, 'IP literal, untrusted');
  const port = new URL(base).port;
  // A NAME that resolves to loopback is checked in the socket's DNS lookup.
  assert.equal(await probeVideoDuration(`http://localhost:${port}/i.mp4`, TRUST), null);
  assert.equal(seen.length, 0, 'nothing reached the server');
  // A trusted host that redirects to an untrusted private one: the hop is refused.
  const { seen: seen2, base: base2 } = await serve((req, res) => {
    res.writeHead(302, { location: `http://localhost:${port}/j.mp4` }); res.end();
  });
  assert.equal(await probeVideoDuration(base2 + '/j.mp4', TRUST), null);
  assert.equal(seen2.length, 1);
  assert.equal(seen.length, 0);
});

test('isPrivateIp', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'nonsense']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['13.203.10.186', '8.8.8.8', '172.32.0.1', '2600:1f18::1', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});
