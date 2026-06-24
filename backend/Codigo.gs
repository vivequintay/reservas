/**
 * ───────────────────────────────────────────────────────────────────────────
 *  BACKEND DE RESERVAS — VIVE QUINTAY SpA   (Google Apps Script + Mercado Pago)
 * ───────────────────────────────────────────────────────────────────────────
 *  Es el "cerebro" del pago. Dos funciones, ambas por doPost:
 *
 *   1) CREAR COBRO  (lo llama la PWA al apretar "IR A PAGAR")
 *      - Recibe los datos de la reserva.
 *      - Crea una "preferencia" de Checkout Pro en Mercado Pago
 *        (monto leído del servidor → el cliente no puede adulterarlo).
 *      - Guarda la reserva como "pendiente" en la planilla (libro mayor).
 *      - Redirige al checkout de Mercado Pago (init_point).
 *
 *   2) WEBHOOK DE MERCADO PAGO  (lo llama MP cuando cambia un pago)
 *      - MP avisa con el id del pago. NO confiamos en el aviso: CONSULTAMOS
 *        el pago a la API de MP con nuestro token (la fuente de verdad).
 *        → imposible de falsificar (Apps Script no expone headers, así que
 *          no usamos x-signature; la autenticación es la consulta firmada).
 *      - Si el pago está "approved": marca la reserva PAGADA, envía correos
 *        (a la empresa y al cliente) y —en 2b— escribe en Firestore.
 *      - Responde 200 SIEMPRE.
 *
 *  Propiedades del script (Proyecto → Configuración → Propiedades del script):
 *    MP_ACCESS_TOKEN  (Access Token de Mercado Pago: TEST o producción)
 *    PRECIO           4000
 *    SHOP_NAME        Vive Quintay SpA
 *    NOTIF_EMAIL      nosectm@gmail.com
 *    PWA_URL          https://vivequintay.github.io/reservas/
 *    SHEET_ID         (lo crea solo setup(), no tocar)
 *
 *  Despliegue: ver INSTRUCCIONES.md
 * ───────────────────────────────────────────────────────────────────────────
 */

var MP_API = 'https://api.mercadopago.com';

// ───────────────────────── Helpers de configuración ─────────────────────────
function prop(k, def) {
  var v = PropertiesService.getScriptProperties().getProperty(k);
  return (v === null || v === '') ? def : v;
}

function ok200() {
  return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
}

// ───────────────────────── Puntos de entrada ────────────────────────────────
function doPost(e) {
  try {
    var p = (e && e.parameter) ? e.parameter : {};
    // Form POST (respaldo sin CORS): 'patente' en los parámetros → respuesta HTML que redirige.
    if (p.patente) return crearCobro(p, 'html');
    // fetch desde la PWA: JSON en el cuerpo → respuesta JSON (sin banner de Apps Script).
    if (e && e.postData && e.postData.contents) {
      var b = {};
      try { b = JSON.parse(e.postData.contents); } catch (_) {}
      if (b && b.patente) return crearCobro(b, 'json');
    }
    // Si no, es notificación de Mercado Pago.
    return manejarWebhookMP(e);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  // MP a veces manda IPN por GET con topic/id.
  var p = (e && e.parameter) ? e.parameter : {};
  if ((p['data.id'] || p.id) && (p.type || p.topic)) return manejarWebhookMP(e);
  return ContentService.createTextOutput('Backend de reservas Vive Quintay — OK').setMimeType(ContentService.MimeType.TEXT);
}

// ───────────────────────────── Crear cobro ──────────────────────────────────
// modo: 'json' (la PWA hace fetch y redirige sola → sin banner) | 'html' (respaldo)
function crearCobro(datos, modo) {
  var p = datos || {};

  var patente  = (p.patente  || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
  var nombre   = (p.nombre   || '').toString().trim();
  var email    = (p.email    || '').toString().trim();
  var telefono = (p.telefono || '').toString().trim();
  var fecha    = (p.fecha    || '').toString().trim();   // YYYY-MM-DD
  var tramo    = (p.tramo    || '').toString().trim();

  if (!patente || !nombre || !email || !fecha || !tramo) {
    return respuestaError(modo, 'Faltan datos de la reserva. Vuelve atrás e inténtalo de nuevo.');
  }

  var precio = parseInt(prop('PRECIO', '4000'), 10);
  var token  = prop('MP_ACCESS_TOKEN', '');
  var pwaUrl = prop('PWA_URL', '');
  var backendUrl = ScriptApp.getService().getUrl();

  // Referencia única (external_reference) — vincula el pago con esta reserva.
  var ref = 'RES-' + fecha.replace(/-/g, '') + '-' + patente + '-' + Utilities.getUuid().substring(0, 8);

  var partes = nombre.split(/\s+/);
  var firstName = partes.shift();
  var lastName  = partes.join(' ') || firstName;

  var pref = {
    items: [{
      title: 'Reserva estacionamiento ' + fecha + ' (' + tramo + ')',
      quantity: 1,
      unit_price: precio,
      currency_id: 'CLP'
    }],
    external_reference: ref,
    payer: { name: firstName, surname: lastName, email: email },
    back_urls: {
      success: pwaUrl + '?estado=ok',
      failure: pwaUrl + '?estado=fallo',
      pending: pwaUrl + '?estado=pendiente'
    },
    auto_return: 'approved',
    notification_url: backendUrl,            // el webhook = este mismo script
    statement_descriptor: 'VIVE QUINTAY',
    binary_mode: true,                       // aprobado o rechazado (sin "pendiente")
    metadata: { patente: patente, fecha: fecha, tramo: tramo, telefono: telefono }
  };

  var resp = UrlFetchApp.fetch(MP_API + '/checkout/preferences', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + token },
    payload: JSON.stringify(pref),
    muteHttpExceptions: true
  });

  var code = resp.getResponseCode();
  var data = {};
  try { data = JSON.parse(resp.getContentText()); } catch (_) {}
  var url = data.init_point || data.sandbox_init_point || '';

  if ((code !== 200 && code !== 201) || !/^https?:\/\//.test(url)) {
    Logger.log('MP preferencia inesperada (%s): %s', code, (resp.getContentText() || '').substring(0, 300));
    return respuestaError(modo, 'No se pudo iniciar el pago. Inténtalo nuevamente en unos minutos.');
  }

  registrarReserva({
    ref: ref, patente: patente, nombre: nombre, email: email, telefono: telefono,
    fecha: fecha, tramo: tramo, monto: precio, estado: 'pendiente'
  });

  return respuestaExito(modo, url);
}

// Respuesta según el modo: JSON (la PWA redirige) o HTML (respaldo, redirige el server).
function respuestaExito(modo, url) {
  if (modo === 'json') {
    return ContentService.createTextOutput(JSON.stringify({ ok: true, url: url }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return paginaRedirect(url);
}

function respuestaError(modo, msg) {
  if (modo === 'json') {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: msg }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return paginaError(msg);
}

// ─────────────────────── Webhook Mercado Pago ───────────────────────────────
function manejarWebhookMP(e) {
  var p = (e && e.parameter) ? e.parameter : {};
  var tipo = (p.type || p.topic || '').toLowerCase();
  var id = p['data.id'] || p.id || '';

  // Por si MP lo envía en el cuerpo JSON.
  if ((!id || !tipo) && e && e.postData && e.postData.contents) {
    try {
      var b = JSON.parse(e.postData.contents);
      tipo = (b.type || b.topic || tipo || '').toLowerCase();
      if (b.data && b.data.id) id = b.data.id;
    } catch (_) {}
  }

  Logger.log('Webhook MP tipo=%s id=%s', tipo, id);

  // Solo pagos (ignoramos merchant_order, etc.).
  if (tipo && tipo.indexOf('payment') < 0) return ok200();
  if (!id) return ok200();

  // Fuente de verdad: consultar el pago a la API de MP con nuestro token.
  var token = prop('MP_ACCESS_TOKEN', '');
  var resp = UrlFetchApp.fetch(MP_API + '/v1/payments/' + encodeURIComponent(id), {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    Logger.log('No se pudo consultar el pago %s (%s)', id, resp.getResponseCode());
    return ok200();
  }
  var pago = {};
  try { pago = JSON.parse(resp.getContentText()); } catch (_) { return ok200(); }

  Logger.log('Pago %s estado=%s ref=%s monto=%s', id, pago.status, pago.external_reference, pago.transaction_amount);

  if (pago.status === 'approved') {
    confirmarReservaPagada(pago.external_reference, pago);
  } else if (pago.status === 'rejected' || pago.status === 'cancelled') {
    actualizarEstadoReserva(pago.external_reference, 'fallido');
  }
  return ok200();
}

function confirmarReservaPagada(ref, pago) {
  if (!ref) { Logger.log('Pago sin external_reference'); return; }
  var fila = buscarReserva(ref);
  if (!fila) { Logger.log('No se encontró la reserva %s', ref); return; }

  // Idempotencia: si ya está pagada, no repetir.
  if (fila.estado === 'pagada') { Logger.log('Reserva %s ya estaba pagada (idempotente)', ref); return; }

  // Verificación extra: el monto pagado coincide con el de la reserva.
  if (pago && pago.transaction_amount && Number(pago.transaction_amount) < Number(fila.monto)) {
    Logger.log('Monto pagado (%s) menor al esperado (%s) para %s', pago.transaction_amount, fila.monto, ref);
    return;
  }

  actualizarEstadoReserva(ref, 'pagada');
  enviarCorreos(fila);

  // ── Etapa 2b: escribir en Firestore para que el escritorio capte la patente ──
  try { escribirReservaEnFirestore(fila); }
  catch (err) { Logger.log('Error escribiendo en Firestore (la reserva igual quedó pagada): %s', err); }
}

// ─────────────────────── Firebase / Firestore (etapa 2b) ─────────────────────
// Autentica como cuenta de servicio (JWT → OAuth) y escribe la reserva pagada
// en la colección 'reservas'. Reutiliza el mismo firebase-key.json del escritorio.
// Configurar en Propiedades del script:
//   FIREBASE_SA       = (TODO el contenido del archivo firebase-key.json)
//   FIREBASE_PROJECT  = vive-quintay-spa   (opcional, ya es el valor por defecto)
function firebaseToken_() {
  var saStr = prop('FIREBASE_SA', '');
  if (!saStr) throw new Error('Falta FIREBASE_SA (pega el contenido de firebase-key.json).');
  var sa = JSON.parse(saStr);
  var now = Math.floor(Date.now() / 1000);
  var enc = function (o) { return Utilities.base64EncodeWebSafe(JSON.stringify(o)).replace(/=+$/, ''); };
  var toSign = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  });
  var sig = Utilities.base64EncodeWebSafe(
    Utilities.computeRsaSha256Signature(toSign, sa.private_key)).replace(/=+$/, '');
  var resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: toSign + '.' + sig },
    muteHttpExceptions: true
  });
  var d = {}; try { d = JSON.parse(resp.getContentText()); } catch (_) {}
  if (!d.access_token) throw new Error('OAuth Firebase falló: ' + resp.getContentText().substring(0, 200));
  return d.access_token;
}

function escribirReservaEnFirestore(r) {
  if (!prop('FIREBASE_SA', '')) {
    Logger.log('FIREBASE_SA no configurado → no se escribe en Firestore (2b pendiente).');
    return;
  }
  var projectId = prop('FIREBASE_PROJECT', 'vive-quintay-spa');
  var token = firebaseToken_();
  var docId = String(r.ref);
  var url = 'https://firestore.googleapis.com/v1/projects/' + projectId +
            '/databases/(default)/documents/reservas/' + encodeURIComponent(docId);
  var body = { fields: {
    patente:  { stringValue: String(r.patente) },
    nombre:   { stringValue: String(r.nombre) },
    email:    { stringValue: String(r.email) },
    telefono: { stringValue: String(r.telefono || '') },
    fecha:    { stringValue: String(r.fecha) },          // YYYY-MM-DD del día reservado
    tramo:    { stringValue: String(r.tramo) },
    monto:    { integerValue: String(r.monto) },
    estado:   { stringValue: 'Pagada' },
    tipo:     { stringValue: 'Pase Diario' },
    ref:      { stringValue: docId },
    creada:   { timestampValue: new Date().toISOString() }
  }};
  var resp = UrlFetchApp.fetch(url, {
    method: 'patch', contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + token },
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  Logger.log('Firestore reservas/%s → %s', docId, resp.getResponseCode());
  if (resp.getResponseCode() >= 300) Logger.log('Detalle: %s', resp.getContentText().substring(0, 250));
}

// Prueba la escritura en Firestore SIN hacer un pago (crea una reserva ficticia).
function probarFirestore() {
  escribirReservaEnFirestore({
    ref: 'RES-TEST-' + Utilities.getUuid().substring(0, 8),
    patente: 'TEST99', nombre: 'Prueba Firestore', email: 'prueba@ejemplo.cl',
    telefono: '', fecha: '2026-07-30', tramo: '12:00 - 13:00', monto: 4000
  });
  Logger.log('Listo. Revisa la colección "reservas" en la consola de Firebase.');
}

// ─────────────────────── Planilla (libro mayor) ─────────────────────────────
var COLS = ['ref', 'fecha', 'tramo', 'patente', 'nombre', 'email', 'telefono', 'monto', 'estado', 'creada', 'actualizada'];

function getHoja() {
  var id = prop('SHEET_ID', '');
  if (!id) throw new Error('SHEET_ID no configurado. Ejecuta la función setup() una vez.');
  return SpreadsheetApp.openById(id).getSheets()[0];
}

function registrarReserva(r) {
  var hoja = getHoja();
  var ahora = new Date();
  hoja.appendRow([r.ref, r.fecha, r.tramo, r.patente, r.nombre, r.email, r.telefono, r.monto, r.estado, ahora, ahora]);
}

function buscarReserva(ref) {
  var hoja = getHoja();
  var datos = hoja.getDataRange().getValues();
  for (var i = 1; i < datos.length; i++) {
    if (datos[i][0] === ref) {
      var obj = { _fila: i + 1 };
      for (var c = 0; c < COLS.length; c++) obj[COLS[c]] = datos[i][c];
      return obj;
    }
  }
  return null;
}

function actualizarEstadoReserva(ref, estado) {
  if (!ref) return;
  var hoja = getHoja();
  var datos = hoja.getDataRange().getValues();
  for (var i = 1; i < datos.length; i++) {
    if (datos[i][0] === ref) {
      hoja.getRange(i + 1, COLS.indexOf('estado') + 1).setValue(estado);
      hoja.getRange(i + 1, COLS.indexOf('actualizada') + 1).setValue(new Date());
      return;
    }
  }
}

// ─────────────────────────────── Correos ────────────────────────────────────
function enviarCorreos(r) {
  var fmt = function (n) { return '$' + Number(n).toLocaleString('es-CL'); };
  var notif = prop('NOTIF_EMAIL', '');

  if (r.email) {
    MailApp.sendEmail({
      to: r.email,
      subject: 'Confirmación de tu reserva — Vive Quintay SpA',
      htmlBody:
        '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#0A2F4F">' +
        '<h2 style="color:#00913B">¡Reserva confirmada! ✅</h2>' +
        '<p>Hola ' + r.nombre + ', tu pago fue recibido y tu lugar está reservado.</p>' +
        '<table style="width:100%;border-collapse:collapse">' +
        fila('Patente', r.patente) + fila('Día', r.fecha) + fila('Tramo horario', r.tramo) +
        fila('Total pagado', fmt(r.monto)) + fila('N° de reserva', r.ref) +
        '</table>' +
        '<p style="margin-top:18px">Te esperamos. La hora es estimada dentro del tramo elegido.</p>' +
        '<p style="color:#888;font-size:12px">Vive Quintay SpA</p></div>'
    });
  }

  if (notif) {
    var sheetId = prop('SHEET_ID', '');
    var linkPlanilla = sheetId ? 'https://docs.google.com/spreadsheets/d/' + sheetId + '/edit' : '';
    MailApp.sendEmail({
      to: notif,
      subject: 'NUEVA RESERVA PAGADA — ' + r.patente + ' (' + r.fecha + ')',
      htmlBody:
        '<div style="font-family:Arial,sans-serif">' +
        '<h3>Nueva reserva pagada</h3>' +
        '<table style="border-collapse:collapse">' +
        fila('Patente', r.patente) + fila('Día', r.fecha) + fila('Tramo', r.tramo) +
        fila('Nombre', r.nombre) + fila('Email', r.email) + fila('Teléfono', r.telefono) +
        fila('Monto', fmt(r.monto)) + fila('Ref', r.ref) +
        '</table>' +
        (linkPlanilla ? '<p style="margin-top:14px"><a href="' + linkPlanilla + '">📋 Ver bitácora completa de reservas</a></p>' : '') +
        '</div>'
    });
  }
}

// Muestra en el registro el link directo a tu planilla/bitácora de reservas.
function verPlanilla() {
  var id = prop('SHEET_ID', '');
  if (!id) { Logger.log('No hay SHEET_ID. Ejecuta setup() primero.'); return; }
  Logger.log('📋 Tu bitácora de reservas:');
  Logger.log('https://docs.google.com/spreadsheets/d/' + id + '/edit');
}

function fila(k, v) {
  return '<tr><td style="padding:4px 12px 4px 0;color:#888">' + k + '</td>' +
         '<td style="padding:4px 0;font-weight:bold">' + (v || '-') + '</td></tr>';
}

// ──────────────────────── Páginas de respuesta HTML ─────────────────────────
function paginaRedirect(url) {
  var html =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{background:#0A2F4F;color:#fff;font-family:Inter,Arial,sans-serif;text-align:center;padding:60px 20px}' +
    '.s{width:46px;height:46px;border:4px solid rgba(255,255,255,.2);border-top-color:#00E0D0;border-radius:50%;margin:20px auto;animation:r 1s linear infinite}' +
    '@keyframes r{to{transform:rotate(360deg)}}a{color:#00E0D0}</style></head><body>' +
    '<h2>Redirigiendo al pago seguro…</h2><div class="s"></div>' +
    '<p>Si no avanzas en unos segundos, <a href="' + url + '">haz clic aquí</a>.</p>' +
    '<script>location.href=' + JSON.stringify(url) + ';</script></body></html>';
  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function paginaError(msg) {
  var pwaUrl = prop('PWA_URL', '');
  var html =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{background:#0A2F4F;color:#fff;font-family:Inter,Arial,sans-serif;text-align:center;padding:60px 20px}a{color:#00E0D0}</style></head><body>' +
    '<h2 style="color:#FF8A80">Ups…</h2><p>' + msg + '</p>' +
    (pwaUrl ? '<p><a href="' + pwaUrl + '">Volver a reservar</a></p>' : '') +
    '</body></html>';
  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ─────────────────── Diagnóstico de credenciales (ejecutar a mano) ───────────
// Verifica que el MP_ACCESS_TOKEN sea válido y muestra de qué cuenta es.
function probarCredencialesMP() {
  var token = prop('MP_ACCESS_TOKEN', '');
  Logger.log('MP_ACCESS_TOKEN presente: %s (largo %s)', token ? 'sí' : 'NO', token.length);
  if (!token) { Logger.log('Falta MP_ACCESS_TOKEN en Propiedades del script.'); return; }
  var r = UrlFetchApp.fetch(MP_API + '/users/me', {
    method: 'get', headers: { 'Authorization': 'Bearer ' + token }, muteHttpExceptions: true
  });
  Logger.log('users/me código: %s', r.getResponseCode());
  if (r.getResponseCode() !== 200) { Logger.log('Respuesta: %s', r.getContentText().substring(0, 200)); return; }
  var u = JSON.parse(r.getContentText());
  Logger.log('✓ Cuenta: %s | nickname: %s | país: %s | email: %s | id: %s',
             (u.first_name || '') + ' ' + (u.last_name || ''), u.nickname, u.site_id, u.email, u.id);
  Logger.log('Modo: %s', (String(token).indexOf('TEST') === 0 || String(token).indexOf('APP_USR') < 0) ? 'parece PRUEBA' : 'parece PRODUCCIÓN');
}

// Crea una preferencia de prueba y muestra el init_point (sin cobrar nada real en TEST).
function diagnosticoMP() {
  var token = prop('MP_ACCESS_TOKEN', '');
  var pref = {
    items: [{ title: 'Reserva de prueba', quantity: 1, unit_price: parseInt(prop('PRECIO', '4000'), 10), currency_id: 'CLP' }],
    external_reference: 'RES-DIAG-' + Utilities.getUuid().substring(0, 8),
    back_urls: { success: prop('PWA_URL', '') + '?estado=ok' },
    auto_return: 'approved'
  };
  var r = UrlFetchApp.fetch(MP_API + '/checkout/preferences', {
    method: 'post', contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + token }, payload: JSON.stringify(pref), muteHttpExceptions: true
  });
  Logger.log('Crear preferencia código: %s', r.getResponseCode());
  var d = {}; try { d = JSON.parse(r.getContentText()); } catch (_) {}
  Logger.log('init_point: %s', d.init_point || '(none)');
  Logger.log('sandbox_init_point: %s', d.sandbox_init_point || '(none)');
  if (!d.init_point) Logger.log('Respuesta: %s', (r.getContentText() || '').substring(0, 300));
}

// ─────────────────────── Setup (ejecutar UNA vez) ───────────────────────────
function setup() {
  var sp = PropertiesService.getScriptProperties();
  if (!sp.getProperty('SHEET_ID')) {
    var ss = SpreadsheetApp.create('Reservas Vive Quintay — Libro Mayor');
    var hoja = ss.getSheets()[0];
    hoja.appendRow(COLS);
    hoja.getRange(1, 1, 1, COLS.length).setFontWeight('bold');
    hoja.setFrozenRows(1);
    sp.setProperty('SHEET_ID', ss.getId());
    Logger.log('Planilla creada: %s', ss.getUrl());
  } else {
    Logger.log('Ya existe SHEET_ID: %s', sp.getProperty('SHEET_ID'));
  }
  var defaults = {
    PRECIO: '4000',
    SHOP_NAME: 'Vive Quintay SpA',
    NOTIF_EMAIL: 'nosectm@gmail.com',
    PWA_URL: 'https://vivequintay.github.io/reservas/'
  };
  for (var k in defaults) if (!sp.getProperty(k)) sp.setProperty(k, defaults[k]);
  Logger.log('Setup completo. Falta poner MP_ACCESS_TOKEN. Propiedades: %s', JSON.stringify(sp.getProperties()));
}
