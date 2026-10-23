// Entry point: wires env config into the scan proxy. See src/app.js for the
// request flow and README.md for deployment notes.

import { createApp } from './src/app.js';
import { ping, scanBuffer } from './src/clamd.js';
import { createQuarantine } from './src/quarantine.js';

const env = process.env;
const PORT = Number(env.PORT || 8083);
const clamd = {
  host: env.CLAMD_HOST || 'clamav',
  port: Number(env.CLAMD_PORT || 3310),
  // Keep a little above clamd's MaxScanTime so clamd reports the timeout itself.
  timeoutMs: Number(env.SCAN_TIMEOUT_MS || 15000),
};

// One JSON line per event, so promtail/loki can filter on `event`.
function log(level, event, fields = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, service: 'filestore-scan-proxy', event, ...fields }));
}

const quarantine = createQuarantine(env);
if (!quarantine) log('warn', 'quarantine_disabled', { reason: 'QUARANTINE_BUCKET or credentials not set' });

const app = createApp({
  upstream: env.FILESTORE_UPSTREAM || 'http://egov-filestore:8083',
  scan: (buf) => scanBuffer(buf, clamd),
  ping: () => ping({ ...clamd, timeoutMs: 3000 }),
  quarantine,
  // nginx caps bodies at 25M; allow multipart overhead on top.
  maxBodyBytes: Number(env.MAX_BODY_BYTES || 26 * 1024 * 1024),
  log,
});

app.listen(PORT, '0.0.0.0', () => log('info', 'listening', { port: PORT, clamd: `${clamd.host}:${clamd.port}` }));
