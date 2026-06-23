/**
 * ───────────────────────────────────────────────────────────────────────────
 *  BACKEND DE RESERVAS — VIVE QUINTAY SpA   (Google Apps Script)
 * ───────────────────────────────────────────────────────────────────────────
 *  Es el "cerebro" del pago. Hace dos cosas, ambas por doPost:
 *
 *   1) CREAR COBRO  (lo llama la PWA al apretar "IR A PAGAR")
 *      - Recibe los datos de la reserva.
 *      - Lee el precio y las credenciales desde las Propiedades del Script
 *        (NUNCA del cliente → el monto no se puede adulterar).
 *      - Crea el Payment Intent en TUU (firmado HMAC-SHA256).
 *      - Guarda la reserva como "pendiente" en la planilla (libro mayor).
 *      - Devuelve una página que redirige al checkout de TUU.
 *
 *   2) WEBHOOK DE TUU  (lo llama TUU cuando el pago se concreta/falla)
 *      - Valida la firma del aviso (que sea TUU de verdad).
 *      - Es idempotente (TUU puede reintentar hasta 10 veces).
 *      - Si "completed": marca la reserva como PAGADA, envía los correos
 *        (a la empresa y al cliente) y —en la etapa 2b— escribe en Firestore.
 *      - Responde 200 SIEMPRE (aunque el pago haya fallado).
 *
 *  Configurar en  Proyecto → Configuración → Propiedades del script:
 *    TUU_ENV          dev | prod          (sandbox o producción)
 *    TUU_ACCOUNT_ID   62224230            (sandbox; en prod el real)
 *    TUU_SECRET       (clave secreta del comercio para firmar)
 *    TUU_SHOP_NAME    Vive Quintay SpA
 *    PRECIO           4000
 *    NOTIF_EMAIL      nosectm@gmail.com
 *    PWA_URL          https://vivequintay.github.io/reservas/
 *    SHEET_ID         (lo crea solo la función setup(), no tocar)
 *
 *  Despliegue: ver INSTRUCCIONES.md
 * ───────────────────────────────────────────────────────────────────────────
 */

// Constante fija de la plataforma TUU (NO es el secreto del comercio).
var TUU_PLATFORM_SECRET = '18756627';
var TUU_ENDPOINTS = {
  dev:  'https://frontend-api.payment.haulmer.dev/v1/payment',
  prod: 'https://core.payment.haulmer.com/api/v1/payment'
};

// ───────────────────────── Helpers de configuración ─────────────────────────
function prop(k, def) {
  var v = PropertiesService.getScriptProperties().getProperty(k);
  return (v === null || v === '') ? def : v;
}

// ───────────────────────── Punto de entrada (POST) ──────────────────────────
function doPost(e) {
  try {
    // TUU envía form-urlencoded con x_result + x_signature → es el webhook.
    if (e && e.parameter && e.parameter.x_result) {
      return manejarWebhook(e.parameter);
    }
    // Si no, es la PWA pidiendo crear el cobro.
    return crearCobro(e);
  } catch (err) {
    // Nunca dejar caer el webhook (TUU espera 200). Para crear cobro, mostramos error.
    return ContentService.createTextOutput('ERROR: ' + err).setMimeType(ContentService.MimeType.TEXT);
  }
}

// Permite probar que el Web App está vivo abriéndolo en el navegador.
function doGet() {
  return ContentService.createTextOutput('Backend de reservas Vive Quintay — OK').setMimeType(ContentService.MimeType.TEXT);
}

// ───────────────────────────── Crear cobro ──────────────────────────────────
function crearCobro(e) {
  var p = (e && e.parameter) ? e.parameter : {};
  // Si vino como JSON en el body (fetch), parsearlo.
  if ((!p.patente) && e && e.postData && e.postData.contents) {
    try { var j = JSON.parse(e.postData.contents); for (var k in j) p[k] = j[k]; } catch (_) {}
  }

  var patente  = (p.patente  || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
  var nombre   = (p.nombre   || '').toString().trim();
  var email    = (p.email    || '').toString().trim();
  var telefono = (p.telefono || '').toString().trim();
  var fecha    = (p.fecha    || '').toString().trim();   // YYYY-MM-DD
  var tramo    = (p.tramo    || '').toString().trim();

  if (!patente || !nombre || !email || !fecha || !tramo) {
    return paginaError('Faltan datos de la reserva. Vuelve atrás e inténtalo de nuevo.');
  }

  var precio = parseInt(prop('PRECIO', '4000'), 10);
  var env    = prop('TUU_ENV', 'dev');
  var endpoint = TUU_ENDPOINTS[env] || TUU_ENDPOINTS.dev;
  var accountId = prop('TUU_ACCOUNT_ID', '');
  var secret    = prop('TUU_SECRET', '');
  var shopName  = prop('TUU_SHOP_NAME', 'Vive Quintay SpA');
  var pwaUrl    = prop('PWA_URL', '');
  var backendUrl = ScriptApp.getService().getUrl();

  // Referencia única (id de la orden) — sirve para idempotencia y firma.
  var ref = 'RES-' + fecha.replace(/-/g, '') + '-' + patente + '-' + Utilities.getUuid().substring(0, 8);

  // Nombre/apellido a partir del nombre completo.
  var partes = nombre.split(/\s+/);
  var firstName = partes.shift();
  var lastName  = partes.join(' ') || firstName;

  var data = {
    platform: 'woocommerce',          // valor que TUU espera para este flujo
    paymentMethod: 'webpay',
    x_account_id: accountId,
    x_amount: precio,
    x_currency: 'CLP',
    x_customer_email: email,
    x_customer_first_name: firstName,
    x_customer_last_name: lastName,
    x_customer_phone: telefono,
    x_description: 'Reserva de estacionamiento ' + fecha + ' (' + tramo + ')',
    x_reference: ref,
    x_shop_country: 'CL',
    x_shop_name: shopName,
    x_url_callback: backendUrl,                          // el webhook = este mismo script
    x_url_cancel:   pwaUrl + '?estado=cancelado&',
    x_url_complete: pwaUrl + '?estado=ok&',
    secret: TUU_PLATFORM_SECRET,
    dte_type: 48
  };

  // Firma: ksort de todo, concatenar solo claves x_ (clave+valor), HMAC-SHA256 con el secreto del comercio.
  data.x_signature = firmarTUU(data, secret);
  // dte se agrega DESPUÉS de firmar (no es campo x_).
  data.dte = { net_amount: precio, exempt_amount: 1, type: 48 };

  var resp = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(data),
    muteHttpExceptions: true
  });

  var body = (resp.getContentText() || '').trim();

  if (resp.getResponseCode() !== 200 || !/^https?:\/\//.test(body)) {
    Logger.log('Respuesta TUU inesperada (%s): %s', resp.getResponseCode(), body);
    return paginaError('No se pudo iniciar el pago. Inténtalo nuevamente en unos minutos.');
  }

  // Guardar la reserva como "pendiente" (libro mayor) — el webhook la actualizará.
  registrarReserva({
    ref: ref, patente: patente, nombre: nombre, email: email, telefono: telefono,
    fecha: fecha, tramo: tramo, monto: precio, estado: 'pendiente'
  });

  // Redirigir el navegador al checkout de TUU.
  return paginaRedirect(body);
}

// ───────────────────────────── Webhook TUU ──────────────────────────────────
function manejarWebhook(params) {
  var secret = prop('TUU_SECRET', '');
  var firmaOk = validarFirmaTUU(params, secret);
  var ref = params.x_reference || '';
  var resultado = (params.x_result || '').toLowerCase();

  Logger.log('Webhook TUU ref=%s result=%s firmaOk=%s', ref, resultado, firmaOk);

  // Si la firma no valida, NO procesamos (posible suplantación), pero respondemos 200
  // para que TUU no reintente eternamente. Queda en el log para revisión.
  if (!firmaOk) {
    Logger.log('FIRMA INVÁLIDA en webhook para ref=%s', ref);
    return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
  }

  if (resultado === 'completed') {
    confirmarReservaPagada(ref, params);
  } else if (resultado === 'failed') {
    actualizarEstadoReserva(ref, 'fallido');
  } // 'pending' → no hacemos nada todavía

  return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
}

function confirmarReservaPagada(ref, params) {
  var fila = buscarReserva(ref);
  if (!fila) { Logger.log('No se encontró la reserva %s', ref); return; }

  // Idempotencia: si ya está pagada, no repetir correos.
  if (fila.estado === 'pagada') { Logger.log('Reserva %s ya estaba pagada (idempotente)', ref); return; }

  actualizarEstadoReserva(ref, 'pagada');

  // Correos de confirmación.
  enviarCorreos(fila);

  // ── Etapa 2b: escribir en Firestore como "Pagada" para que aparezca en caja ──
  // escribirReservaEnFirestore(fila);   // (se habilita en 2b con la cuenta de servicio)
}

// ─────────────────────────────── Firma TUU ──────────────────────────────────
function firmarTUU(data, secret) {
  var claves = Object.keys(data).sort();      // ksort
  var msg = '';
  for (var i = 0; i < claves.length; i++) {
    var k = claves[i];
    if (k.indexOf('x_') === 0 && k !== 'x_signature') msg += k + data[k];
  }
  var raw = Utilities.computeHmacSha256Signature(msg, secret);
  return raw.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

function validarFirmaTUU(params, secret) {
  var recibida = params.x_signature || '';
  if (!recibida) return false;
  var calculada = firmarTUU(params, secret);
  return recibida === calculada;
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
  var fechaBonita = r.fecha;
  var notif = prop('NOTIF_EMAIL', '');

  // Al cliente
  if (r.email) {
    MailApp.sendEmail({
      to: r.email,
      subject: 'Confirmación de tu reserva — Vive Quintay SpA',
      htmlBody:
        '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#0A2F4F">' +
        '<h2 style="color:#00913B">¡Reserva confirmada! ✅</h2>' +
        '<p>Hola ' + r.nombre + ', tu pago fue recibido y tu lugar está reservado.</p>' +
        '<table style="width:100%;border-collapse:collapse">' +
        fila('Patente', r.patente) + fila('Día', fechaBonita) + fila('Tramo horario', r.tramo) +
        fila('Total pagado', fmt(r.monto)) + fila('N° de reserva', r.ref) +
        '</table>' +
        '<p style="margin-top:18px">Te esperamos. La hora es estimada dentro del tramo elegido.</p>' +
        '<p style="color:#888;font-size:12px">Vive Quintay SpA</p></div>'
    });
  }

  // A la empresa
  if (notif) {
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
        '</table></div>'
    });
  }
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
  // Valores por defecto si faltan (no pisa los existentes).
  var defaults = {
    TUU_ENV: 'dev',
    TUU_ACCOUNT_ID: '62224230',
    TUU_SECRET: 'yAk0dXTJLQzkeEWODsQWVpPX0bn7ND50qwoQrXgqqNiUyEpgxIPxPtoCgKeLNeh1upTw72JZx5O9x5IaAtPIGUAVcMNcsUSg3M0M8tgWdUb4F8qkS8I7rHpOUmZqzvfS',
    TUU_SHOP_NAME: 'Vive Quintay SpA',
    PRECIO: '4000',
    NOTIF_EMAIL: 'nosectm@gmail.com',
    PWA_URL: 'https://vivequintay.github.io/reservas/'
  };
  for (var k in defaults) if (!sp.getProperty(k)) sp.setProperty(k, defaults[k]);
  Logger.log('Setup completo. Propiedades: %s', JSON.stringify(sp.getProperties()));
}
