// End-to-end tests against a fake clamd (real INSTREAM protocol) and a fake
// egov-filestore. Run with: npm test

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { ping, scanBuffer } from '../src/clamd.js';

// Industry-standard harmless antivirus test string.
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const ENCRYPTED_MARKER = 'FAKE-ENCRYPTED-ZIP';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Fake clamd: decodes INSTREAM chunks and flags EICAR / the encrypted marker.
function fakeClamd() {
  return net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let cmd = null;
    const data = [];
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (cmd === null) {
        const nul = buf.indexOf(0);
        if (nul === -1) return;
        cmd = buf.subarray(0, nul).toString();
        buf = buf.subarray(nul + 1);
        if (cmd === 'zPING') return sock.end('PONG\0');
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          const body = Buffer.concat(data).toString('latin1');
          if (body.includes(EICAR)) return sock.end('stream: Win.Test.EICAR_HDB-1 FOUND\0');
          if (body.includes(ENCRYPTED_MARKER)) return sock.end('stream: Heuristics.Encrypted.Zip FOUND\0');
          return sock.end('stream: OK\0');
        }
        if (buf.length < 4 + len) return;
        data.push(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
      }
    });
  });
}

describe('filestore-scan-proxy', () => {
  let clamd, clamdPort, upstream, upstreamPort, proxy, base;
  let upstreamHits, quarantined, logs, clamdUp;

  before(async () => {
    clamd = fakeClamd();
    clamdPort = await listen(clamd);

    upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        upstreamHits.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('latin1') });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ files: [{ fileStoreId: 'fs-123', tenantId: 'ke' }] }));
      });
    });
    upstreamPort = await listen(upstream);

    const clamdOpts = () => ({ host: '127.0.0.1', port: clamdUp ? clamdPort : 1, timeoutMs: 2000 });
    proxy = createApp({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      scan: (b) => scanBuffer(b, clamdOpts()),
      ping: () => ping(clamdOpts()),
      quarantine: async (buf, meta) => {
        quarantined.push({ buf, meta });
        return 'ke/2026/10/12/test.bin';
      },
      maxBodyBytes: 1024 * 1024,
      log: (level, event, fields) => logs.push({ level, event, ...fields }),
    });
    base = `http://127.0.0.1:${await listen(proxy)}`;
  });

  after(() => {
    proxy.close();
    upstream.close();
    clamd.close();
  });

  beforeEach(() => {
    upstreamHits = [];
    quarantined = [];
    logs = [];
    clamdUp = true;
  });

  function upload(content, filename = 'photo.jpg', path = '/filestore/v1/files') {
    const fd = new FormData();
    fd.append('tenantId', 'ke.bomet');
    fd.append('module', 'PGR');
    fd.append('file', new Blob([content], { type: 'image/jpeg' }), filename);
    return fetch(base + path, { method: 'POST', body: fd });
  }

  it('forwards clean uploads unchanged and returns filestore response', async () => {
    const res = await upload('just a normal photo');
    assert.equal(res.status, 201);
    assert.equal((await res.json()).files[0].fileStoreId, 'fs-123');
    assert.equal(upstreamHits.length, 1);
    assert.match(upstreamHits[0].body, /just a normal photo/);
    assert.equal(quarantined.length, 0);
  });

  it('blocks infected uploads, quarantines them, never reaches filestore', async () => {
    const res = await upload(EICAR, 'evil.pdf');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).Errors[0].code, 'VIRUS_DETECTED');
    assert.equal(upstreamHits.length, 0);
    assert.equal(quarantined.length, 1);
    const { meta } = quarantined[0];
    assert.equal(meta.signature, 'Win.Test.EICAR_HDB-1');
    assert.equal(meta.filename, 'evil.pdf');
    assert.equal(meta.tenantId, 'ke.bomet');
    assert.match(meta.sha256, /^[0-9a-f]{64}$/);
    assert.ok(logs.some((l) => l.event === 'virus_detected'));
  });

  it('does not leak the signature name to the client', async () => {
    const res = await upload(EICAR);
    assert.doesNotMatch(await res.text(), /EICAR/);
  });

  it('rejects encrypted files without quarantining them', async () => {
    const res = await upload(ENCRYPTED_MARKER, 'locked.zip');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).Errors[0].code, 'FILE_NOT_SCANNABLE');
    assert.equal(upstreamHits.length, 0);
    assert.equal(quarantined.length, 0);
  });

  it('fails closed with 503 when clamd is down', async () => {
    clamdUp = false;
    const res = await upload('anything');
    assert.equal(res.status, 503);
    assert.equal((await res.json()).Errors[0].code, 'SCAN_UNAVAILABLE');
    assert.equal(upstreamHits.length, 0);
  });

  it('scans multipart requests on unusual paths too', async () => {
    const res = await upload(EICAR, 'x.jpg', '/filestore//v1/files;jsessionid=abc');
    assert.equal(res.status, 400);
    assert.equal(upstreamHits.length, 0);
  });

  it('blocks when any one of several files is infected', async () => {
    const fd = new FormData();
    fd.append('tenantId', 'ke');
    fd.append('file', new Blob(['clean']), 'a.jpg');
    fd.append('file', new Blob([EICAR]), 'b.jpg');
    const res = await fetch(base + '/filestore/v1/files', { method: 'POST', body: fd });
    assert.equal(res.status, 400);
    assert.equal(upstreamHits.length, 0);
  });

  it('rejects oversize bodies with 413', async () => {
    const res = await upload('x'.repeat(2 * 1024 * 1024));
    assert.equal(res.status, 413);
    assert.equal(upstreamHits.length, 0);
  });

  it('rejects malformed multipart instead of forwarding it', async () => {
    const res = await fetch(base + '/filestore/v1/files', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data' }, // no boundary
      body: EICAR,
    });
    assert.equal(res.status, 400);
    assert.equal(upstreamHits.length, 0);
  });

  it('passes non-upload requests straight through', async () => {
    const res = await fetch(base + '/filestore/v1/files/url?tenantId=ke&fileStoreIds=fs-1');
    assert.equal(res.status, 201);
    assert.equal(upstreamHits[0].method, 'GET');
    assert.equal(upstreamHits[0].url, '/filestore/v1/files/url?tenantId=ke&fileStoreIds=fs-1');
  });

  it('health reflects clamd availability', async () => {
    assert.equal((await fetch(base + '/health')).status, 200);
    clamdUp = false;
    assert.equal((await fetch(base + '/health')).status, 503);
  });
});
