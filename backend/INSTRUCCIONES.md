# Backend de reservas — despliegue (Google Apps Script + Mercado Pago)

Este backend crea el cobro en Mercado Pago (Checkout Pro), recibe el webhook,
registra la reserva en una planilla y envía los correos de confirmación.

> Etapa actual: **2a** (pago + correos + planilla). La escritura en Firestore
> para que aparezca en caja es la etapa **2b**.

## 0. Obtener tu Access Token de Mercado Pago (self-service)

1. Entra a <https://www.mercadopago.cl/developers> con tu cuenta.
2. **Tus integraciones** → **Crear aplicación** → nombre `Reservas Vive Quintay`,
   producto **Checkout Pro / Pagos online**.
3. En la app → **Credenciales**. Verás dos juegos:
   - **Credenciales de prueba** → `Access Token` (empieza con `TEST-...`).
   - **Credenciales de producción** → `Access Token` (empieza con `APP_USR-...`).
4. Para empezar usa el de **prueba**.

## 1. Crear el proyecto

1. Entra a <https://script.google.com> con la cuenta de Vive Quintay.
2. **Nuevo proyecto** → nómbralo `Reservas Vive Quintay`.
3. Borra el contenido y pega **todo** [`Codigo.gs`](Codigo.gs). Guarda (💾).

## 2. Inicializar y configurar

1. Elige la función **`setup`** → **Ejecutar** → autoriza permisos. Crea la
   planilla y deja los valores por defecto (PRECIO, correo, PWA_URL).
2. En **⚙️ Configuración del proyecto → Propiedades del script**, agrega:

   | Propiedad | Valor |
   |-----------|-------|
   | `MP_ACCESS_TOKEN` | tu Access Token de **prueba** (`TEST-...`) |

   (`PRECIO`, `SHOP_NAME`, `NOTIF_EMAIL`, `PWA_URL`, `SHEET_ID` ya quedaron.)

3. Verifica las credenciales: ejecuta **`probarCredencialesMP`** y revisa el
   registro → debe mostrar `✓ Cuenta: ... | país: MLC`. Luego ejecuta
   **`diagnosticoMP`** → debe mostrar un `init_point`.

## 3. Publicar como aplicación web

1. **Implementar → Nueva implementación → Aplicación web**.
2. **Ejecutar como:** Yo. **Quién tiene acceso:** **Cualquier usuario**.
3. **Implementar** y copia la **URL** (`…/exec`).

> Al editar el código, usa **Gestionar implementaciones → ✏️ → Versión nueva**
> para mantener la misma URL.

## 4. Conectar la PWA

Pásame la **URL `…/exec`**. La pego en `index.html` (`BACKEND_URL`) y el botón
"IR A PAGAR" crea el cobro real en Mercado Pago.

## 5. Probar (modo prueba)

1. En la PWA, haz una reserva → te lleva al checkout de Mercado Pago.
2. Paga con una **tarjeta de prueba** de Mercado Pago (las ves en tu panel, en
   *Cuentas de prueba* / *Tarjetas de prueba*; para aprobar usa el titular `APRO`).
3. Verifica: vuelves a la PWA con "reserva confirmada", llegan los correos, y la
   fila de la planilla pasa de `pendiente` a `pagada`.

## 6. Pasar a producción

Cambia en **Propiedades del script**:
- `MP_ACCESS_TOKEN` → tu Access Token de **producción** (`APP_USR-...`).

Publica una **versión nueva**. Desde ahí los pagos son reales y caen en tu cuenta
Mercado Pago.

---

### Notas técnicas (para Claude / mantenimiento)

- **Crear cobro:** `POST api.mercadopago.com/checkout/preferences` con
  `Authorization: Bearer {MP_ACCESS_TOKEN}`. Body con `items`
  (title/quantity/unit_price/`currency_id:"CLP"`), `external_reference` (= ref de
  la reserva), `back_urls`, `auto_return:"approved"`, `notification_url` (este
  script). Respuesta trae **`init_point`** (URL de pago) y `sandbox_init_point`.
- **Webhook:** MP hace POST a `notification_url` con `type=payment` y
  `data.id=<id pago>` (en query o body). Apps Script **no expone headers**, así
  que NO usamos `x-signature`; en su lugar **consultamos el pago**:
  `GET /v1/payments/{id}` con Bearer (fuente de verdad, imposible de falsificar).
  Si `status==="approved"` → reserva `pagada` (idempotente por `external_reference`).
- **Etapa 2b:** habilitar `escribirReservaEnFirestore()` en
  `confirmarReservaPagada()` con una cuenta de servicio del proyecto
  `vive-quintay-spa`.
