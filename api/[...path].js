const crypto = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PIN = String(process.env.BONOS_PIN || '1234');
const AUTH_SECRET = process.env.AUTH_SECRET || process.env.BONOS_PIN || 'bonos-dev-secret';

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function clean(value) {
  return String(value ?? '').trim();
}

function requireSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    const error = new Error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY');
    error.status = 500;
    throw error;
  }
}

function signToken() {
  const payload = Buffer.from(JSON.stringify({ app: 'bonos', iat: Date.now() })).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function isAuthorized(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function supabaseRequest(endpoint, options = {}) {
  requireSupabase();
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.message || data?.details || 'Error de Supabase');
    error.status = response.status;
    error.code = data?.code;
    throw error;
  }
  return data;
}

function requirePeriod(value) {
  if (!/^\d{4}-\d{2}$/.test(String(value || ''))) {
    const error = new Error('Periodo invalido. Usar formato AAAA-MM');
    error.status = 400;
    throw error;
  }
  return value;
}

function defaultConfig() {
  return { empresa: 'Empresa bonos verduleria', montoMensual: 10000 };
}

function mapConfig(row) {
  return {
    empresa: row?.empresa || defaultConfig().empresa,
    montoMensual: Number(row?.monto_mensual || defaultConfig().montoMensual)
  };
}

function mapEmployee(row) {
  return {
    id: row.id,
    nombre: row.nombre,
    dni: row.dni,
    legajo: row.legajo || '',
    activo: row.activo !== false,
    createdAt: row.created_at
  };
}

function mapUse(row) {
  return row ? {
    id: row.id,
    empleadoId: row.empleado_id,
    periodo: row.periodo,
    monto: Number(row.monto),
    usadoAt: row.usado_at
  } : null;
}

async function ensureConfig() {
  const rows = await supabaseRequest('bono_config?id=eq.1&select=*');
  if (rows.length) return mapConfig(rows[0]);
  const inserted = await supabaseRequest('bono_config', {
    method: 'POST',
    body: JSON.stringify({ id: 1, empresa: defaultConfig().empresa, monto_mensual: defaultConfig().montoMensual })
  });
  return mapConfig(inserted[0]);
}

async function loadState(periodo) {
  const [config, empleadosRows, usosRows] = await Promise.all([
    ensureConfig(),
    supabaseRequest('bono_empleados?select=*&order=nombre.asc'),
    supabaseRequest(`bono_usos?periodo=eq.${encodeURIComponent(periodo)}&select=*`)
  ]);
  const usos = usosRows.map(mapUse);
  const empleados = empleadosRows.map(mapEmployee).map((empleado) => ({
    ...empleado,
    uso: usos.find((uso) => uso.empleadoId === empleado.id) || null
  }));
  const activos = empleados.filter((empleado) => empleado.activo !== false);
  const usados = activos.filter((empleado) => empleado.uso);
  return {
    config,
    periodo,
    resumen: {
      activos: activos.length,
      usados: usados.length,
      pendientes: activos.length - usados.length,
      total: usados.reduce((sum, empleado) => sum + Number(empleado.uso.monto || config.montoMensual), 0)
    },
    empleados
  };
}

async function handle(req, res, pathname) {
  if (pathname === '/login' && req.method === 'POST') {
    const body = await readBody(req);
    if (String(body.pin || '') !== PIN) return json(res, 401, { error: 'PIN incorrecto' });
    return json(res, 200, { token: signToken() });
  }

  if (!isAuthorized(req)) return json(res, 401, { error: 'Acceso no autorizado' });

  if (pathname === '/state' && req.method === 'GET') {
    const periodo = requirePeriod(req.query.periodo || new Date().toISOString().slice(0, 7));
    return json(res, 200, await loadState(periodo));
  }

  if (pathname === '/config' && req.method === 'PUT') {
    const body = await readBody(req);
    await supabaseRequest('bono_config?id=eq.1', {
      method: 'PATCH',
      body: JSON.stringify({
        empresa: clean(body.empresa) || defaultConfig().empresa,
        monto_mensual: Number(body.montoMensual || defaultConfig().montoMensual)
      })
    });
    return json(res, 200, { ok: true });
  }

  if (pathname === '/empleados' && req.method === 'POST') {
    const body = await readBody(req);
    const nombre = clean(body.nombre);
    const dni = clean(body.dni);
    if (!nombre || !dni) return json(res, 400, { error: 'Nombre y DNI son obligatorios' });
    try {
      const inserted = await supabaseRequest('bono_empleados', {
        method: 'POST',
        body: JSON.stringify({ nombre, dni, legajo: clean(body.legajo), activo: true })
      });
      return json(res, 201, mapEmployee(inserted[0]));
    } catch (error) {
      if (error.code === '23505') return json(res, 409, { error: 'Ese DNI ya esta cargado' });
      throw error;
    }
  }

  if (pathname === '/empleados/importar' && req.method === 'POST') {
    const body = await readBody(req);
    let importados = 0;
    let omitidos = 0;
    for (const item of Array.isArray(body.empleados) ? body.empleados : []) {
      const nombre = clean(item.nombre);
      const dni = clean(item.dni);
      if (!nombre || !dni) {
        omitidos += 1;
        continue;
      }
      try {
        await supabaseRequest('bono_empleados', {
          method: 'POST',
          body: JSON.stringify({ nombre, dni, legajo: clean(item.legajo), activo: true })
        });
        importados += 1;
      } catch (error) {
        if (error.code !== '23505') throw error;
        omitidos += 1;
      }
    }
    return json(res, 201, { importados, omitidos });
  }

  const empleadoMatch = pathname.match(/^\/empleados\/([^/]+)$/);
  if (empleadoMatch && req.method === 'PUT') {
    const body = await readBody(req);
    await supabaseRequest(`bono_empleados?id=eq.${encodeURIComponent(empleadoMatch[1])}`, {
      method: 'PATCH',
      body: JSON.stringify({
        nombre: clean(body.nombre),
        dni: clean(body.dni),
        legajo: clean(body.legajo),
        activo: body.activo === true || body.activo === 'true' || body.activo === 1
      })
    });
    return json(res, 200, { ok: true });
  }

  if (pathname === '/usos' && req.method === 'POST') {
    const body = await readBody(req);
    const periodo = requirePeriod(body.periodo);
    const config = await ensureConfig();
    try {
      const inserted = await supabaseRequest('bono_usos', {
        method: 'POST',
        body: JSON.stringify({
          empleado_id: body.empleadoId,
          periodo,
          monto: Number(body.monto || config.montoMensual)
        })
      });
      return json(res, 201, mapUse(inserted[0]));
    } catch (error) {
      if (error.code === '23505') return json(res, 409, { error: 'Ese empleado ya uso el bono este mes' });
      if (error.code === '23503') return json(res, 404, { error: 'Empleado no encontrado' });
      throw error;
    }
  }

  const usoMatch = pathname.match(/^\/usos\/([^/]+)$/);
  if (usoMatch && req.method === 'DELETE') {
    const periodo = requirePeriod(req.query.periodo);
    await supabaseRequest(`bono_usos?empleado_id=eq.${encodeURIComponent(usoMatch[1])}&periodo=eq.${encodeURIComponent(periodo)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' }
    });
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Ruta no encontrada' });
}

module.exports = async function handler(req, res) {
  try {
    const pathParts = Array.isArray(req.query.path) ? req.query.path : [];
    const pathname = `/${pathParts.join('/')}`;
    await handle(req, res, pathname);
  } catch (error) {
    json(res, error.status || 500, { error: error.message || 'Error interno' });
  }
};
