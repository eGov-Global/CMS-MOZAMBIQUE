// HTTP proxy in front of egov-filestore. Kong routes /filestore here.
//
//   multipart request  → buffer → parse → clamd scan every part
//                          clean     → forward the original bytes upstream
//                          infected  → quarantine + 400 VIRUS_DETECTED
//                          encrypted / over scan limits → 400 FILE_NOT_SCANNABLE
//                          clamd down / error → 503 SCAN_UNAVAILABLE (fail closed)
//   anything else      → streamed straight through
//
// Every multipart request is scanned regardless of path or method, so path
// tricks (`//`, `;jsessionid`, trailing slash) that Tomcat normalises can't
// slip an upload past the scanner.

import crypto from 'node:crypto';
import http from 'node:http';
import busboy from 'busboy';

// Parts smaller than this that busboy reports as plain fields (tenantId,
// module, tag) aren't worth a clamd round trip. Anything larger is scanned
// even without a filename, in case filestore's parser sees it as a file.
const FIELD_SCAN_THRESHOLD = 4 * 1024;

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer'];

function digitError(res, status, code, message) {
  const body = JSON.stringify({
    ResponseInfo: null,
    Errors: [{ code, message, description: message, params: null }],
  });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function clientIp(req) {
  return String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0]
    .trim();
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      // Over the limit: stop buffering but keep draining (nginx already caps
      // the total), so the client gets a clean 413 instead of a reset.
      if (size <= maxBytes) chunks.push(c);
    });
    req.on('end', () => {
      if (size <= maxBytes) return resolve(Buffer.concat(chunks));
      const err = new Error('body too large');
      err.tooLarge = true;
      reject(err);
    });
    req.on('error', reject);
  });
}

function parseParts(headers, body, maxBytes) {
  return new Promise((resolve, reject) => {
    const files = [];
    const pending = [];
    const fields = {};
    let bb;
    try {
      bb = busboy({ headers, limits: { fileSize: maxBytes, fieldSize: maxBytes }, defParamCharset: 'utf8' });
    } catch (err) {
      reject(err);
      return;
    }
    bb.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('limit', () => reject(new Error(`part ${name} exceeds size limit`)));
      pending.push(
        new Promise((done) =>
          stream.on('end', () => {
            files.push({ name, filename: info.filename, mimeType: info.mimeType, data: Buffer.concat(chunks) });
            done();
          }),
        ),
      );
    });
    bb.on('field', (name, value, info) => {
      if (info.valueTruncated) {
        reject(new Error(`field ${name} truncated`));
        return;
      }
      fields[name] = value;
      if (Buffer.byteLength(value) > FIELD_SCAN_THRESHOLD) {
        files.push({ name, filename: '', mimeType: info.mimeType, data: Buffer.from(value) });
      }
    });
    bb.on('error', reject);
    bb.on('close', () => Promise.all(pending).then(() => resolve({ files, fields })));
    bb.end(body);
  });
}

function upstreamHeaders(req, upstream, bodyLength) {
  const headers = { ...req.headers };
  for (const h of HOP_BY_HOP) delete headers[h];
  headers.host = upstream.host;
  if (bodyLength !== undefined) headers['content-length'] = String(bodyLength);
  return headers;
}

function forward(req, res, upstream, log, body) {
  const proxyReq = http.request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req, upstream, body ? body.length : undefined),
    },
    (proxyRes) => {
      const headers = { ...proxyRes.headers };
      for (const h of HOP_BY_HOP) if (h !== 'transfer-encoding') delete headers[h];
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', (err) => {
    log('error', 'upstream_error', { error: err.message });
    if (!res.headersSent) digitError(res, 502, 'FILESTORE_UNAVAILABLE', 'File service is unavailable');
    else res.destroy();
  });
  if (body) proxyReq.end(body);
  else req.pipe(proxyReq);
}

/**
 * opts:
 *   upstream     URL of egov-filestore
 *   scan(buf)    → { status: 'clean' } | { status: 'infected', signature }; throws when unavailable
 *   ping()       → boolean
 *   quarantine   async (buf, meta) → key, or null to disable
 *   maxBodyBytes reject larger requests with 413
 *   log(level, event, fields)
 */
export function createApp(opts) {
  const upstream = new URL(opts.upstream);
  const log = opts.log;

  async function handleUpload(req, res) {
    let body;
    try {
      body = await readBody(req, opts.maxBodyBytes);
    } catch (err) {
      if (err.tooLarge) return digitError(res, 413, 'FILE_TOO_LARGE', 'File is too large');
      log('warn', 'read_error', { error: err.message });
      return digitError(res, 400, 'INVALID_UPLOAD', 'Upload could not be read');
    }

    let parsed;
    try {
      parsed = await parseParts(req.headers, body, opts.maxBodyBytes);
    } catch (err) {
      // Refuse what we can't parse rather than forward something unscanned.
      log('warn', 'parse_error', { error: err.message, ip: clientIp(req) });
      return digitError(res, 400, 'INVALID_UPLOAD', 'Upload could not be read');
    }

    const started = Date.now();
    for (const part of parsed.files) {
      let result;
      try {
        result = await opts.scan(part.data);
      } catch (err) {
        log('error', 'scan_unavailable', { error: err.message });
        return digitError(res, 503, 'SCAN_UNAVAILABLE', 'File upload is temporarily unavailable, please try again later');
      }
      if (result.status === 'clean') continue;

      const sha256 = crypto.createHash('sha256').update(part.data).digest('hex');
      const meta = {
        filename: part.filename,
        mimeType: part.mimeType,
        signature: result.signature,
        sha256,
        tenantId: parsed.fields.tenantId,
        module: parsed.fields.module,
        clientIp: clientIp(req),
      };

      // Encrypted or over-limit files aren't known malware — they just
      // couldn't be checked. Reject, but don't keep a copy of citizen data.
      if (/^Heuristics\.(Encrypted|Limits)/.test(result.signature)) {
        log('warn', 'upload_not_scannable', { ...meta, size: part.data.length });
        return digitError(
          res,
          400,
          'FILE_NOT_SCANNABLE',
          'File could not be checked (it may be password-protected or too complex)',
        );
      }

      let quarantineKey = null;
      if (opts.quarantine) {
        try {
          quarantineKey = await opts.quarantine(part.data, meta);
        } catch (err) {
          // Never let a quarantine failure change the verdict.
          log('error', 'quarantine_failed', { error: err.message, sha256 });
        }
      }
      log('warn', 'virus_detected', { ...meta, size: part.data.length, quarantineKey });
      return digitError(res, 400, 'VIRUS_DETECTED', 'File failed security scan');
    }

    log('info', 'upload_clean', { parts: parsed.files.length, bytes: body.length, scanMs: Date.now() - started });
    forward(req, res, upstream, log, body);
  }

  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      opts
        .ping()
        .then((ok) => {
          res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: ok ? 'ok' : 'clamd_unavailable' }));
        })
        .catch(() => {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'clamd_unavailable' }));
        });
      return;
    }

    if (/multipart\//i.test(String(req.headers['content-type'] || ''))) {
      handleUpload(req, res).catch((err) => {
        log('error', 'unhandled', { error: err.message });
        if (!res.headersSent) digitError(res, 500, 'INTERNAL_ERROR', 'Upload failed');
      });
      return;
    }

    forward(req, res, upstream, log);
  });
}
