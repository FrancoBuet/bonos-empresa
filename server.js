const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3333);
const PIN = String(process.env.BONOS_PIN || '1234');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'bonos-data.json');
const authToken = crypto.randomBytes(32).toString('hex');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

let writeQueue = Promise.resolve();

function defaultData() {
  return {
    config: {
      empresa: 'Empresa bonos verduleria',
      montoMensual: 10000
    },
    empleados: [],
    usos: []
  };
}

function send(res, status, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function sendError(res, status, message) {
  send(res, status, { error: message });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('JSON invalido');
    error.status = 400;
    throw error;
  }
}

async function loadData() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const data = JSON.parse(raw);
    return {
      config: { ...defaultData().config, ...(data.config || {}) },
      empleados: Array.isArray(data.empleados) ? data.empleados : [],
      usos: Array.isArray(data.usos) ? data.usos : []
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const data = defaultData();
    await saveData(data);
    return data;
  }
}

async function saveData(data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temp = `${DATA_FILE}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(temp, DATA_FILE);
}

async function updateData(mutator) {
  writeQueue = writeQueue.then(async () => {
    const data = await loadData();
    const result = await mutator(data);
    await saveData(data);
    return result;
  });
  return writeQueue;
}

async function supabaseRequest(endpoint, options = {}) {
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

function mapConfig(row) {
  return {
    empresa: row?.empresa || defaultData().config.empresa,
    montoMensual: Number(row?.monto_mensual || defaultData().config.montoMensual)
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

async function ensureSupabaseConfig() {
  const rows = await supabaseRequest('bono_config?id=eq.1&select=*');
  if (rows.length) return mapConfig(rows[0]);
  const inserted = await supabaseRequest('bono_config', {
    method: 'POST',
    body: JSON.stringify({ id: 1, empresa: defaultData().config.empresa, monto_mensual: defaultData().config.montoMensual })
  });
  return mapConfig(inserted[0]);
}

async function loadSupabaseState(periodo) {
  const [config, empleadosRows, usosRows] = await Promise.all([
    ensureSupabaseConfig(),
    supabaseRequest('bono_empleados?select=*&order=nombre.asc'),
    supabaseRequest(`bono_usos?periodo=eq.${encodeURIComponent(periodo)}&select=*`)
  ]);
  const usos = usosRows.map(mapUse);
  const empleados = empleadosRows
    .map(mapEmployee)
    .map((empleado) => publicEmployee(empleado, usos.find((uso) => uso.empleadoId === empleado.id)));
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

async function loadState(periodo) {
  if (USE_SUPABASE) return loadSupabaseState(periodo);
  const data = await loadData();
  return stateForPeriod(data, periodo);
}

function isAuthorized(req) {
  const header = req.headers.authorization || '';
  return header === `Bearer ${authToken}`;
}

function requirePeriod(value) {
  if (!/^\d{4}-\d{2}$/.test(String(value || ''))) {
    const error = new Error('Periodo invalido. Usar formato AAAA-MM');
    error.status = 400;
    throw error;
  }
  return value;
}

function clean(value) {
  return String(value ?? '').trim();
}

function publicEmployee(empleado, uso) {
  return {
    ...empleado,
    uso: uso || null
  };
}

function stateForPeriod(data, periodo) {
  const empleados = data.empleados
    .slice()
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
    .map((empleado) => publicEmployee(empleado, data.usos.find((uso) => uso.empleadoId === empleado.id && uso.periodo === periodo)));
  const activos = empleados.filter((empleado) => empleado.activo !== false);
  const usados = activos.filter((empleado) => empleado.uso);
  return {
    config: data.config,
    periodo,
    resumen: {
      activos: activos.length,
      usados: usados.length,
      pendientes: activos.length - usados.length,
      total: usados.reduce((sum, empleado) => sum + Number(empleado.uso.monto || data.config.montoMensual), 0)
    },
    empleados
  };
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = await readJson(req);
    if (String(body.pin || '') !== PIN) return sendError(res, 401, 'PIN incorrecto');
    return send(res, 200, { token: authToken });
  }

  if (!isAuthorized(req)) return sendError(res, 401, 'Acceso no autorizado');

  if (url.pathname === '/api/state' && req.method === 'GET') {
    const periodo = requirePeriod(url.searchParams.get('periodo') || new Date().toISOString().slice(0, 7));
    return send(res, 200, await loadState(periodo));
  }

  if (url.pathname === '/api/config' && req.method === 'PUT') {
    const body = await readJson(req);
    if (USE_SUPABASE) {
      await supabaseRequest('bono_config?id=eq.1', {
        method: 'PATCH',
        body: JSON.stringify({
          empresa: clean(body.empresa) || defaultData().config.empresa,
          monto_mensual: Number(body.montoMensual || defaultData().config.montoMensual)
        })
      });
      return send(res, 200, { ok: true });
    }
    await updateData((data) => {
      data.config.empresa = clean(body.empresa) || data.config.empresa;
      data.config.montoMensual = Number(body.montoMensual || data.config.montoMensual);
    });
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/empleados' && req.method === 'POST') {
    const body = await readJson(req);
    if (USE_SUPABASE) {
      const nombre = clean(body.nombre);
      const dni = clean(body.dni);
      if (!nombre || !dni) return sendError(res, 400, 'Nombre y DNI son obligatorios');
      try {
        const inserted = await supabaseRequest('bono_empleados', {
          method: 'POST',
          body: JSON.stringify({ nombre, dni, legajo: clean(body.legajo), activo: true })
        });
        return send(res, 201, mapEmployee(inserted[0]));
      } catch (error) {
        if (error.code === '23505') return sendError(res, 409, 'Ese DNI ya esta cargado');
        throw error;
      }
    }
    const result = await updateData((data) => {
      const nombre = clean(body.nombre);
      const dni = clean(body.dni);
      const legajo = clean(body.legajo);
      if (!nombre || !dni) {
        const error = new Error('Nombre y DNI son obligatorios');
        error.status = 400;
        throw error;
      }
      if (data.empleados.some((empleado) => empleado.dni.toLowerCase() === dni.toLowerCase())) {
        const error = new Error('Ese DNI ya esta cargado');
        error.status = 409;
        throw error;
      }
      const empleado = {
        id: crypto.randomUUID(),
        nombre,
        dni,
        legajo,
        activo: true,
        createdAt: new Date().toISOString()
      };
      data.empleados.push(empleado);
      return empleado;
    });
    return send(res, 201, result);
  }

  if (url.pathname === '/api/empleados/importar' && req.method === 'POST') {
    const body = await readJson(req);
    if (USE_SUPABASE) {
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
      return send(res, 201, { importados, omitidos });
    }
    const result = await updateData((data) => {
      let importados = 0;
      let omitidos = 0;
      for (const item of Array.isArray(body.empleados) ? body.empleados : []) {
        const nombre = clean(item.nombre);
        const dni = clean(item.dni);
        const legajo = clean(item.legajo);
        if (!nombre || !dni || data.empleados.some((empleado) => empleado.dni.toLowerCase() === dni.toLowerCase())) {
          omitidos += 1;
          continue;
        }
        data.empleados.push({ id: crypto.randomUUID(), nombre, dni, legajo, activo: true, createdAt: new Date().toISOString() });
        importados += 1;
      }
      return { importados, omitidos };
    });
    return send(res, 201, result);
  }

  const empleadoMatch = url.pathname.match(/^\/api\/empleados\/([^/]+)$/);
  if (empleadoMatch && req.method === 'PUT') {
    const body = await readJson(req);
    if (USE_SUPABASE) {
      await supabaseRequest(`bono_empleados?id=eq.${encodeURIComponent(empleadoMatch[1])}`, {
        method: 'PATCH',
        body: JSON.stringify({
          nombre: clean(body.nombre),
          dni: clean(body.dni),
          legajo: clean(body.legajo),
          activo: body.activo === true || body.activo === 'true' || body.activo === 1
        })
      });
      return send(res, 200, { ok: true });
    }
    await updateData((data) => {
      const empleado = data.empleados.find((item) => item.id === empleadoMatch[1]);
      if (!empleado) {
        const error = new Error('Empleado no encontrado');
        error.status = 404;
        throw error;
      }
      empleado.nombre = clean(body.nombre) || empleado.nombre;
      empleado.dni = clean(body.dni) || empleado.dni;
      empleado.legajo = clean(body.legajo);
      empleado.activo = body.activo === true || body.activo === 'true' || body.activo === 1;
    });
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/usos' && req.method === 'POST') {
    const body = await readJson(req);
    const periodo = requirePeriod(body.periodo);
    if (USE_SUPABASE) {
      const config = await ensureSupabaseConfig();
      try {
        const inserted = await supabaseRequest('bono_usos', {
          method: 'POST',
          body: JSON.stringify({
            empleado_id: body.empleadoId,
            periodo,
            monto: Number(body.monto || config.montoMensual)
          })
        });
        return send(res, 201, mapUse(inserted[0]));
      } catch (error) {
        if (error.code === '23505') return sendError(res, 409, 'Ese empleado ya uso el bono este mes');
        if (error.code === '23503') return sendError(res, 404, 'Empleado no encontrado');
        throw error;
      }
    }
    const result = await updateData((data) => {
      const empleado = data.empleados.find((item) => item.id === body.empleadoId && item.activo !== false);
      if (!empleado) {
        const error = new Error('Empleado activo no encontrado');
        error.status = 404;
        throw error;
      }
      if (data.usos.some((uso) => uso.empleadoId === empleado.id && uso.periodo === periodo)) {
        const error = new Error('Ese empleado ya uso el bono este mes');
        error.status = 409;
        throw error;
      }
      const uso = {
        id: crypto.randomUUID(),
        empleadoId: empleado.id,
        periodo,
        monto: Number(body.monto || data.config.montoMensual),
        usadoAt: new Date().toISOString()
      };
      data.usos.push(uso);
      return uso;
    });
    return send(res, 201, result);
  }

  const usoMatch = url.pathname.match(/^\/api\/usos\/([^/]+)$/);
  if (usoMatch && req.method === 'DELETE') {
    const periodo = requirePeriod(url.searchParams.get('periodo'));
    if (USE_SUPABASE) {
      await supabaseRequest(`bono_usos?empleado_id=eq.${encodeURIComponent(usoMatch[1])}&periodo=eq.${encodeURIComponent(periodo)}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' }
      });
      return send(res, 200, { ok: true });
    }
    await updateData((data) => {
      data.usos = data.usos.filter((uso) => !(uso.empleadoId === usoMatch[1] && uso.periodo === periodo));
    });
    return send(res, 200, { ok: true });
  }

  return sendError(res, 404, 'Ruta no encontrada');
}

async function serveStatic(req, res, url) {
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const target = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!target.startsWith(PUBLIC_DIR)) return sendError(res, 403, 'Ruta no permitida');
  try {
    const content = await fs.readFile(target);
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(content);
  } catch {
    sendError(res, 404, 'Archivo no encontrado');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    sendError(res, error.status || 500, error.message || 'Error interno');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Bonos empresa iniciado en http://localhost:${PORT}`);
  console.log(`PIN de acceso: ${PIN}`);
  console.log(`Base de datos: ${USE_SUPABASE ? 'Supabase' : 'JSON local'}`);
});
