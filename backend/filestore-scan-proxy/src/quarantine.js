// Stores infected uploads in a private MinIO bucket for later investigation.
//
// The proxy's MinIO user is expected to hold s3:PutObject on the quarantine
// bucket and nothing else (see minio-init in the compose files), so this
// module can write evidence but never read or list it back.

import crypto from 'node:crypto';
import { Client } from 'minio';

/**
 * Returns an async put(buffer, meta) → objectKey, or null when quarantine is
 * not configured (QUARANTINE_BUCKET / credentials unset).
 */
export function createQuarantine(env) {
  const bucket = env.QUARANTINE_BUCKET;
  if (!bucket || !env.QUARANTINE_ACCESS_KEY || !env.QUARANTINE_SECRET_KEY) return null;

  const url = new URL(env.QUARANTINE_MINIO_URL || 'http://minio:9000');
  const client = new Client({
    endPoint: url.hostname,
    port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    useSSL: url.protocol === 'https:',
    accessKey: env.QUARANTINE_ACCESS_KEY,
    secretKey: env.QUARANTINE_SECRET_KEY,
    // Explicit region skips the GetBucketLocation lookup, which a
    // PutObject-only policy is (correctly) not allowed to call.
    region: env.QUARANTINE_REGION || 'us-east-1',
  });

  return async function put(buffer, meta) {
    const now = new Date();
    const tenant = String(meta.tenantId || 'unknown').toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 64);
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    // No original extension: nobody should be able to double-click this open.
    const key = `${tenant}/${yyyy}/${mm}/${dd}/${crypto.randomUUID()}.bin`;

    await client.putObject(bucket, key, buffer, buffer.length, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment',
      // User metadata must be header-safe ASCII; filenames can be anything.
      'original-filename': encodeURIComponent(meta.filename || ''),
      'declared-mime-type': encodeURIComponent(meta.mimeType || ''),
      signature: encodeURIComponent(meta.signature || ''),
      sha256: meta.sha256 || '',
      'tenant-id': encodeURIComponent(meta.tenantId || ''),
      module: encodeURIComponent(meta.module || ''),
      'client-ip': encodeURIComponent(meta.clientIp || ''),
      'detected-at': now.toISOString(),
    });
    return key;
  };
}
