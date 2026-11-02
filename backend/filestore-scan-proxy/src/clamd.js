// Minimal clamd client over TCP (INSTREAM + PING). Speaks the z-prefixed,
// NUL-terminated variant of the protocol: https://docs.clamav.net/manual/Usage/Scanning.html#clamd
//
// The file is streamed from memory — nothing is written to disk on either side.

import net from 'node:net';

// Must stay at or below clamd's StreamMaxLength chunking expectations; clamd
// accepts any chunk size up to StreamMaxLength, 64 KiB keeps memory flat.
const CHUNK = 64 * 1024;

function request(host, port, timeoutMs, write) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const parts = [];
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(arg);
    };
    socket.setTimeout(timeoutMs, () => done(reject, new Error(`clamd timed out after ${timeoutMs}ms`)));
    socket.on('error', (err) => done(reject, err));
    socket.on('data', (d) => {
      parts.push(d);
      const buf = Buffer.concat(parts);
      const nul = buf.indexOf(0);
      if (nul !== -1) done(resolve, buf.subarray(0, nul).toString('utf8').trim());
    });
    socket.on('end', () => done(resolve, Buffer.concat(parts).toString('utf8').replace(/\0/g, '').trim()));
    socket.on('connect', () => write(socket));
  });
}

/**
 * Scan a buffer. Resolves to one of:
 *   { status: 'clean' }
 *   { status: 'infected', signature }   — includes Heuristics.* alerts (encrypted, limits exceeded)
 * Rejects when clamd is unreachable, times out, or answers with an ERROR line.
 */
export async function scanBuffer(buffer, { host, port, timeoutMs }) {
  const reply = await request(host, port, timeoutMs, (socket) => {
    socket.write('zINSTREAM\0');
    for (let off = 0; off < buffer.length; off += CHUNK) {
      const chunk = buffer.subarray(off, off + CHUNK);
      const len = Buffer.alloc(4);
      len.writeUInt32BE(chunk.length, 0);
      socket.write(len);
      socket.write(chunk);
    }
    socket.write(Buffer.alloc(4)); // zero-length chunk terminates the stream
  });

  // "stream: OK" | "stream: <Signature> FOUND" | "<message> ERROR"
  if (/^stream: OK$/.test(reply)) return { status: 'clean' };
  const found = /^stream: (.+) FOUND$/.exec(reply);
  if (found) return { status: 'infected', signature: found[1] };
  throw new Error(`clamd error: ${reply || '(empty reply)'}`);
}

export async function ping({ host, port, timeoutMs }) {
  const reply = await request(host, port, timeoutMs, (socket) => socket.write('zPING\0'));
  return reply === 'PONG';
}
