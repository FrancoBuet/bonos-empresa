const state = {
  token: localStorage.getItem('bonos_token'),
  data: null,
  soloPendientes: false
};

const money = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const currentPeriod = new Date().toISOString().slice(0, 7);

function $(selector) {
  return document.querySelector(selector);
}

function formObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.token}`,
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) showLogin();
    throw new Error(data.error || 'No se pudo completar la operacion');
  }
  return data;
}

function showLogin() {
  $('#loginView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
}

function showApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
}

function period() {
  return $('#periodo').value || currentPeriod;
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
}

function filteredEmployees() {
  const term = ($('#buscar').value || '').trim().toLowerCase();
  return (state.data?.empleados || []).filter((empleado) => {
    if (state.soloPendientes && (empleado.activo === false || empleado.uso)) return false;
    if (!term) return true;
    return [empleado.nombre, empleado.dni, empleado.legajo].some((field) => String(field || '').toLowerCase().includes(term));
  });
}

function render() {
  const data = state.data;
  if (!data) return;
  $('#empresa').value = data.config.empresa;
  $('#monto').value = data.config.montoMensual;
  $('#statActivos').textContent = data.resumen.activos;
  $('#statUsados').textContent = data.resumen.usados;
  $('#statPendientes').textContent = data.resumen.pendientes;
  $('#statTotal').textContent = money.format(data.resumen.total);

  const rows = filteredEmployees();
  if (!rows.length) {
    $('#tabla').innerHTML = '<tr><td class="empty" colspan="5">No hay empleados para mostrar.</td></tr>';
    return;
  }

  $('#tabla').innerHTML = rows.map((empleado) => {
    const inactive = empleado.activo === false;
    const estado = inactive
      ? '<span class="badge inactive">Inactivo</span>'
      : empleado.uso
        ? `<span class="badge">Usado ${formatDateTime(empleado.uso.usadoAt)}</span>`
        : '<span class="badge warn">Pendiente</span>';
    const acciones = inactive
      ? `<button class="secondary mini" data-active="${empleado.id}" data-value="true">Activar</button>`
      : empleado.uso
        ? `<button class="secondary mini" data-undo="${empleado.id}">Deshacer</button><button class="secondary mini" data-active="${empleado.id}" data-value="false">Baja</button>`
        : `<button class="mini" data-use="${empleado.id}">Marcar usado</button><button class="secondary mini" data-active="${empleado.id}" data-value="false">Baja</button>`;
    return `
      <tr>
        <td><strong>${escapeHtml(empleado.nombre)}</strong></td>
        <td>${escapeHtml(empleado.dni)}</td>
        <td>${escapeHtml(empleado.legajo || '-')}</td>
        <td>${estado}</td>
        <td><div class="row-actions">${acciones}</div></td>
      </tr>
    `;
  }).join('');
}

async function loadState() {
  state.data = await api(`/api/state?periodo=${encodeURIComponent(period())}`);
  render();
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

$('#periodo').value = currentPeriod;

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#loginError').textContent = '';
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formObject(event.currentTarget))
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'No se pudo ingresar');
    state.token = data.token;
    localStorage.setItem('bonos_token', state.token);
    showApp();
    await loadState();
  } catch (error) {
    $('#loginError').textContent = error.message;
  }
});

$('#logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('bonos_token');
  state.token = null;
  showLogin();
});

$('#refreshBtn').addEventListener('click', loadState);
$('#periodo').addEventListener('change', loadState);
$('#buscar').addEventListener('input', render);
$('#soloPendientes').addEventListener('click', () => {
  state.soloPendientes = true;
  render();
});
$('#verTodos').addEventListener('click', () => {
  state.soloPendientes = false;
  render();
});

$('#configForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await api('/api/config', { method: 'PUT', body: JSON.stringify(formObject(event.currentTarget)) });
  await loadState();
});

$('#empleadoForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await api('/api/empleados', { method: 'POST', body: JSON.stringify(formObject(event.currentTarget)) });
  event.currentTarget.reset();
  await loadState();
});

$('#importForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const empleados = $('#csv').value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [nombre, dni, legajo] = parseCsvLine(line);
      return { nombre, dni, legajo };
    });
  const result = await api('/api/empleados/importar', { method: 'POST', body: JSON.stringify({ empleados }) });
  $('#csv').value = '';
  await loadState();
  alert(`Importados: ${result.importados}. Omitidos: ${result.omitidos}.`);
});

$('#tabla').addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.use) {
    await api('/api/usos', {
      method: 'POST',
      body: JSON.stringify({ empleadoId: button.dataset.use, periodo: period(), monto: $('#monto').value })
    });
  }
  if (button.dataset.undo) {
    await api(`/api/usos/${button.dataset.undo}?periodo=${encodeURIComponent(period())}`, { method: 'DELETE' });
  }
  if (button.dataset.active) {
    const empleado = state.data.empleados.find((item) => item.id === button.dataset.active);
    await api(`/api/empleados/${empleado.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        nombre: empleado.nombre,
        dni: empleado.dni,
        legajo: empleado.legajo,
        activo: button.dataset.value === 'true'
      })
    });
  }
  await loadState();
});

$('#exportar').addEventListener('click', () => {
  const rows = [['periodo', 'nombre', 'dni', 'legajo', 'estado', 'fecha_uso', 'monto']];
  for (const empleado of state.data?.empleados || []) {
    if (empleado.activo === false) continue;
    rows.push([
      period(),
      empleado.nombre,
      empleado.dni,
      empleado.legajo || '',
      empleado.uso ? 'USADO' : 'PENDIENTE',
      empleado.uso ? formatDateTime(empleado.uso.usadoAt) : '',
      empleado.uso ? empleado.uso.monto : state.data.config.montoMensual
    ]);
  }
  downloadCsv(`reporte-bonos-${period()}.csv`, rows);
});

if (state.token) {
  showApp();
  loadState().catch(() => showLogin());
} else {
  showLogin();
}
