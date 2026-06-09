const DEPLOYMENTS_TABLE = 'headset_deployments';
const AUDIT_TABLE = 'auditLog';
const MAX_SIGNATURE_BYTES = 900_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = cors(env, request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      if (url.pathname === '/health') {
        return json({ ok: true, service: 'workspace-aaf-signer' }, 200, corsHeaders);
      }

      if (url.pathname === '/form' && request.method === 'GET') {
        const code = normalizeCode(url.searchParams.get('code'));
        if (!code) return json({ error: 'Missing or invalid signing code.' }, 400, corsHeaders);

        const record = await findDeploymentByCode(env, code);
        if (!record) return json({ error: 'Form not found or link expired.' }, 404, corsHeaders);

        return json({ form: publicForm(record) }, 200, corsHeaders);
      }

      if (url.pathname === '/sign' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        const code = normalizeCode(body?.code);
        const signature = String(body?.signature || '');
        const signedName = cleanText(body?.signedName || '', 120);

        if (!code) return json({ error: 'Missing or invalid signing code.' }, 400, corsHeaders);
        if (!isValidSignature(signature)) return json({ error: 'Invalid or oversized signature.' }, 400, corsHeaders);

        const record = await findDeploymentByCode(env, code);
        if (!record) return json({ error: 'Form not found or link expired.' }, 404, corsHeaders);
        if (record.signature) {
          return json({ form: publicForm(record), alreadySigned: true }, 409, corsHeaders);
        }

        const signedAt = new Date().toISOString();
        const updated = {
          ...record,
          signature,
          signedAt: signedAt.slice(0, 10),
          signedAtIso: signedAt,
          signedName: signedName || record.employeeName || '',
          signedVia: 'public-signer',
        };

        const auditId = makeId();
        await turso(env, [
          execute(`INSERT OR REPLACE INTO ${DEPLOYMENTS_TABLE} (id, data) VALUES (?, ?)`, [
            updated.id,
            JSON.stringify(updated),
          ]),
          execute(`INSERT OR REPLACE INTO ${AUDIT_TABLE} (id, data) VALUES (?, ?)`, [
            auditId,
            JSON.stringify({
              id: auditId,
              module: 'Accountability',
              type: 'sign',
              user: signedName || updated.employeeName || 'Public signer',
              displayName: signedName || updated.employeeName || 'Public signer',
              detail: `Signed accountability form for ${updated.employeeName || 'employee'} via public signer`,
              ref: auditAssetRef(updated),
              ts: signedAt,
            }),
          ]),
        ]);

        return json({ form: publicForm(updated), ok: true }, 200, corsHeaders);
      }

      return json({ error: 'Not found.' }, 404, corsHeaders);
    } catch (error) {
      return json({ error: 'Signer service failed.', detail: error.message }, 500, corsHeaders);
    }
  },
};

function cors(env, request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGIN || '').trim();
  const allowOrigin = allowed === '*' || !allowed
    ? '*'
    : origin === allowed || origin.startsWith(`${allowed}/`)
      ? origin
      : allowed;
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(payload, status, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...headers,
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}

async function findDeploymentByCode(env, code) {
  await ensureTables(env);
  const direct = await turso(env, [
    execute(`SELECT data FROM ${DEPLOYMENTS_TABLE} WHERE id = ?`, [code]),
  ]);
  const directRows = direct?.results?.[0]?.response?.result?.rows || [];
  if (directRows.length) return parseRow(directRows[0]);

  const all = await turso(env, [
    execute(`SELECT data FROM ${DEPLOYMENTS_TABLE}`),
  ]);
  const rows = all?.results?.[0]?.response?.result?.rows || [];
  for (const row of rows) {
    const record = parseRow(row);
    if (record && (record.signingCode === code || record.signingToken === code)) return record;
  }
  return null;
}

async function ensureTables(env) {
  await turso(env, [
    execute(`CREATE TABLE IF NOT EXISTS ${DEPLOYMENTS_TABLE} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`),
    execute(`CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`),
  ]);
}

async function turso(env, requests) {
  const databaseUrl = String(env.TURSO_DATABASE_URL || '').replace(/\/$/, '');
  const token = String(env.TURSO_AUTH_TOKEN || '');
  if (!databaseUrl || !token) throw new Error('Turso Worker secrets are not configured.');

  const response = await fetch(`${databaseUrl}/v2/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requests: [...requests, { type: 'close' }] }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `Turso HTTP ${response.status}`);
  const failed = data.results?.find(result => result?.type === 'error');
  if (failed) throw new Error(failed.error?.message || 'Turso query failed.');
  return data;
}

function execute(sql, args = []) {
  return {
    type: 'execute',
    stmt: {
      sql,
      args: args.map(value => value === null
        ? { type: 'null' }
        : { type: 'text', value: String(value) }),
    },
  };
}

function parseRow(row) {
  const raw = row?.[0]?.value ?? row?.data?.value ?? row?.data ?? '';
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function publicForm(record) {
  return {
    id: record.id,
    signingCode: record.signingCode || record.signingToken || record.id,
    employeeName: record.employeeName || '',
    jobTitle: record.jobTitle || '',
    department: record.department || '',
    site: record.site || '',
    floor: record.floor || '',
    emailAddress: record.emailAddress || '',
    fsItamObr: record.fsItamObr || '',
    requestedBy: record.requestedBy || '',
    dateRequested: record.dateRequested || '',
    dateRelease: record.dateRelease || '',
    itPersonnel: record.itPersonnel || '',
    assetPurpose: record.assetPurpose || '',
    duration: record.duration || '',
    authorityTo: record.authorityTo || '',
    assets: Array.isArray(record.assets) && record.assets.length
      ? record.assets
      : [{ type: record.assetType || '', brand: record.assetBrand || '', serialNo: record.serialNo || '' }],
    signature: record.signature || null,
    signedAt: record.signedAt || null,
    signedName: record.signedName || '',
  };
}

function normalizeCode(value) {
  const code = String(value || '').trim();
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(code)) return '';
  return code;
}

function isValidSignature(value) {
  if (!/^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(value)) return false;
  return value.length <= MAX_SIGNATURE_BYTES;
}

function cleanText(value, max) {
  return String(value || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
}

function auditAssetRef(record) {
  const assets = Array.isArray(record.assets) && record.assets.length
    ? record.assets
    : [{ type: record.assetType || '', brand: record.assetBrand || '', serialNo: record.serialNo || '' }];
  return assets.map(asset => [asset.brand, asset.type, asset.serialNo].filter(Boolean).join(' · ')).filter(Boolean).join('; ');
}

function makeId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
}
