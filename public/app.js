const state = {
  token: localStorage.getItem('bonos_token'),
  data: null,
  soloPendientes: false,
  messageTimer: null
};

const money = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const currentPeriod = new Date().toISOString().slice(0, 7);

function $(selector) {
  return document.querySelector(selector);
}

function formObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function notify(message, type = 'ok') {
  const box = $('#appMessage');
  if (!box) return;
  clearTimeout(state.messageTimer);
  box.textContent = message;
  box.className = `message ${type}`;
  state.messageTimer = setTimeout(() => box.classList.add('hidden'), 4200);
}

function buttonBusy(button, busyText) {
  if (!button) return () => {};
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  return () => {
    button.disabled = false;
    button.textContent = originalText;
  };
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
    return [empleado.nombre, empleado.dni].some((field) => String(field || '').toLowerCase().includes(term));
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
    $('#tabla').innerHTML = '<tr><td class="empty" colspan="4">No hay empleados para mostrar.</td></tr>';
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
      ? `<button class="danger mini" data-delete="${empleado.id}">Eliminar</button>`
      : empleado.uso
        ? `<button class="secondary mini" data-undo="${empleado.id}">Deshacer</button><button class="danger mini" data-delete="${empleado.id}">Eliminar</button>`
        : `<button class="mini" data-use="${empleado.id}">Marcar usado</button><button class="danger mini" data-delete="${empleado.id}">Eliminar</button>`;
    return `
      <tr>
        <td><strong>${escapeHtml(empleado.nombre)}</strong></td>
        <td>${escapeHtml(empleado.dni)}</td>
        <td>${estado}</td>
        <td><div class="row-actions">${acciones}</div></td>
      </tr>
    `;
  }).join('');
}

async function loadState() {
  state.data = await api(`/api/state?periodo=${encodeURIComponent(period())}&t=${Date.now()}`);
  render();
}

function parseCsvLine(line) {
  const delimiter = line.includes(';') ? ';' : line.includes('\t') ? '\t' : ',';
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
    } else if (char === delimiter && !quoted) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function parseEmployeesCsv(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [nombre, dni] = parseCsvLine(line);
      return { nombre, dni };
    });
}

function setImportStatus(message, type = 'ok') {
  const status = $('#importStatus');
  if (!status) return;
  status.textContent = message;
  status.className = `form-status ${type}`;
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

function periodLabel(value) {
  const [year, month] = value.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
}

function formatDateOnly(value) {
  return value ? new Date(value).toLocaleDateString('es-AR') : '';
}

function reportRows(usadosOnly = false) {
  return (state.data?.empleados || [])
    .filter((empleado) => empleado.activo !== false)
    .filter((empleado) => !usadosOnly || empleado.uso)
    .slice()
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

function openPdfReport() {
  if (!state.data) return;
  const data = state.data;
  const usados = reportRows(true);
  const pendientes = reportRows(false).filter((empleado) => !empleado.uso);
  const generatedAt = new Date().toLocaleString('es-AR');
  const rowsHtml = usados.length
    ? usados.map((empleado, index) => `
        <tr>
          <td>${index + 1}</td>
          <td>${escapeHtml(empleado.nombre)}</td>
          <td>${escapeHtml(empleado.dni)}</td>
          <td>${formatDateOnly(empleado.uso.usadoAt)}</td>
          <td class="money">${money.format(empleado.uso.monto || data.config.montoMensual)}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="5" class="empty-print">No hay bonos usados para este periodo.</td></tr>';
  const pendientesHtml = pendientes.length
    ? pendientes.map((empleado) => `<li>${escapeHtml(empleado.nombre)} - DNI ${escapeHtml(empleado.dni)}</li>`).join('')
    : '<li>Sin pendientes.</li>';
  const html = `
    <!doctype html>
    <html lang="es">
      <head>
        <meta charset="utf-8">
        <title>Reporte bonos ${escapeHtml(periodLabel(period()))}</title>
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; padding: 28px; color: #111827; font-family: Arial, Helvetica, sans-serif; }
          header { border-bottom: 2px solid #2563eb; padding-bottom: 16px; margin-bottom: 18px; }
          .eyebrow { color: #64748b; font-size: 12px; font-weight: 700; text-transform: uppercase; margin: 0 0 6px; }
          h1 { font-size: 28px; margin: 0; }
          h2 { font-size: 16px; margin: 22px 0 10px; }
          .meta { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 24px; margin-top: 12px; color: #334155; font-size: 13px; }
          .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 18px 0; }
          .summary div { border: 1px solid #d7dee8; border-radius: 6px; padding: 10px; }
          .summary span { display: block; color: #64748b; font-size: 12px; margin-bottom: 5px; }
          .summary strong { display: block; font-size: 18px; }
          table { width: 100%; border-collapse: collapse; font-size: 12px; }
          th, td { border-bottom: 1px solid #d7dee8; padding: 8px; text-align: left; }
          th { background: #f8fafc; color: #475569; text-transform: uppercase; font-size: 11px; }
          .money { text-align: right; font-weight: 700; }
          .total-row td { border-top: 2px solid #111827; font-size: 14px; font-weight: 700; }
          ul { margin: 0; padding-left: 18px; columns: 2; font-size: 12px; }
          .empty-print { text-align: center; color: #64748b; }
          footer { margin-top: 26px; color: #64748b; font-size: 11px; }
          @media print { body { padding: 16px; } button { display: none; } }
        </style>
      </head>
      <body>
        <header>
          <p class="eyebrow">Reporte mensual de bonos</p>
          <h1>${escapeHtml(data.config.empresa)}</h1>
          <div class="meta">
            <div><strong>Periodo:</strong> ${escapeHtml(periodLabel(period()))}</div>
            <div><strong>Generado:</strong> ${escapeHtml(generatedAt)}</div>
            <div><strong>Monto por bono:</strong> ${money.format(data.config.montoMensual)}</div>
            <div><strong>Total a cobrar:</strong> ${money.format(data.resumen.total)}</div>
          </div>
        </header>

        <section class="summary">
          <div><span>Empleados activos</span><strong>${data.resumen.activos}</strong></div>
          <div><span>Bonos usados</span><strong>${data.resumen.usados}</strong></div>
          <div><span>Pendientes</span><strong>${data.resumen.pendientes}</strong></div>
          <div><span>Total a cobrar</span><strong>${money.format(data.resumen.total)}</strong></div>
        </section>

        <h2>Detalle de bonos a cobrar</h2>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Empleado</th>
              <th>DNI</th>
              <th>Fecha de uso</th>
              <th class="money">Monto</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
            <tr class="total-row">
              <td colspan="4">Total</td>
              <td class="money">${money.format(data.resumen.total)}</td>
            </tr>
          </tbody>
        </table>

        <h2>Empleados pendientes</h2>
        <ul>${pendientesHtml}</ul>

        <footer>Reporte generado por Bonos Empresa.</footer>
        <script>window.addEventListener('load', () => setTimeout(() => window.print(), 250));</script>
      </body>
    </html>
  `;
  const reportWindow = window.open('', '_blank');
  if (!reportWindow) {
    notify('El navegador bloqueo la ventana del PDF. Permití popups para exportar.', 'error');
    return;
  }
  reportWindow.document.open();
  reportWindow.document.write(html);
  reportWindow.document.close();
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
  const done = buttonBusy(event.submitter, 'Guardando...');
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify(formObject(event.currentTarget)) });
    await loadState();
    notify('Configuracion guardada.');
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    done();
  }
});

$('#empleadoForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const done = buttonBusy(event.submitter, 'Agregando...');
  try {
    const empleado = await api('/api/empleados', { method: 'POST', body: JSON.stringify(formObject(form)) });
    if (state.data?.empleados) {
      state.data.empleados.push({ ...empleado, uso: null });
      state.data.resumen.activos += 1;
      state.data.resumen.pendientes += 1;
      render();
    }
    form.reset();
    await loadState();
    notify('Empleado agregado.');
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    done();
  }
});

$('#importForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  setImportStatus('');
  const submitButton = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
  const done = buttonBusy(submitButton, 'Importando...');
  const empleados = parseEmployeesCsv($('#csv').value);
  if (!empleados.length) {
    const message = 'Pega empleados en la lista o selecciona un archivo CSV.';
    setImportStatus(message, 'error');
    notify(message, 'error');
    done();
    return;
  }
  try {
    const result = await api('/api/empleados/importar', { method: 'POST', body: JSON.stringify({ empleados }) });
    $('#csv').value = '';
    $('#csvFile').value = '';
    await loadState();
    const message = `Importados: ${result.importados}. Omitidos: ${result.omitidos}.`;
    setImportStatus(message);
    notify(message);
  } catch (error) {
    setImportStatus(error.message, 'error');
    notify(error.message, 'error');
  } finally {
    done();
  }
});

$('#csvFile').addEventListener('change', async (event) => {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  try {
    $('#csv').value = await file.text();
    setImportStatus(`Archivo cargado: ${file.name}. Ahora toca Importar lista.`);
  } catch (error) {
    setImportStatus('No se pudo leer el archivo CSV.', 'error');
  }
});

$('#tabla').addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const empleadoParaEliminar = button.dataset.delete
    ? state.data.empleados.find((item) => item.id === button.dataset.delete)
    : null;
  if (empleadoParaEliminar && !confirm(`Eliminar definitivamente a ${empleadoParaEliminar.nombre}? Tambien se borran sus marcas de bonos.`)) {
    return;
  }
  const done = buttonBusy(button, '...');
  try {
    if (button.dataset.use) {
      await api('/api/usos', {
        method: 'POST',
        body: JSON.stringify({ empleadoId: button.dataset.use, periodo: period(), monto: $('#monto').value })
      });
      notify('Bono marcado como usado.');
    }
    if (button.dataset.undo) {
      await api(`/api/usos/${button.dataset.undo}?periodo=${encodeURIComponent(period())}`, { method: 'DELETE' });
      notify('Marca deshecha.');
    }
    if (button.dataset.delete) {
      await api(`/api/empleados/${button.dataset.delete}`, { method: 'DELETE' });
      notify('Empleado eliminado de la base de datos.');
    }
    await loadState();
  } catch (error) {
    notify(error.message, 'error');
  } finally {
    done();
  }
});

$('#exportarPdf').addEventListener('click', openPdfReport);

if (state.token) {
  showApp();
  loadState().catch(() => showLogin());
} else {
  showLogin();
}
