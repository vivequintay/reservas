# Backend de reservas — despliegue (Google Apps Script)

Este backend es el "cerebro" del pago: crea el cobro en TUU, recibe el webhook
firmado, registra la reserva en una planilla y envía los correos de confirmación.

> Etapa actual: **2a** (pago sandbox + correos + planilla). La escritura en
> Firestore para que aparezca en caja es la etapa **2b** (más adelante).

## 1. Crear el proyecto

1. Entra a <https://script.google.com> con la cuenta de Google de Vive Quintay.
2. **Nuevo proyecto**. Ponle nombre: `Reservas Vive Quintay`.
3. Borra el contenido de `Código.gs` y pega **todo** el contenido de
   [`Codigo.gs`](Codigo.gs).
4. Guarda (💾).

## 2. Inicializar (crea la planilla y las propiedades)

1. Arriba, en el selector de función, elige **`setup`** y pulsa **Ejecutar**.
2. Te pedirá **autorizar permisos** (planillas, correo, conexión externa). Acepta.
   - Si aparece "Google no verificó esta app" → *Configuración avanzada* →
     *Ir a Reservas Vive Quintay (no seguro)*. Es tu propio script, es seguro.
3. Abre **Ver → Registros** (o `Ctrl+Enter`): verás el enlace de la planilla
   creada ("Reservas Vive Quintay — Libro Mayor"). Ya quedó guardada.

Esto deja configurado, por defecto, el **sandbox de TUU** y el correo
`nosectm@gmail.com`. Puedes revisarlas/editarlas en
**Configuración del proyecto ⚙️ → Propiedades del script**:

| Propiedad | Valor (sandbox) |
|-----------|-----------------|
| `TUU_ENV` | `dev` |
| `TUU_ACCOUNT_ID` | `62224230` |
| `TUU_SECRET` | (clave de prueba ya cargada) |
| `TUU_SHOP_NAME` | `Vive Quintay SpA` |
| `PRECIO` | `4000` |
| `NOTIF_EMAIL` | `nosectm@gmail.com` |
| `PWA_URL` | `https://vivequintay.github.io/reservas/` |
| `SHEET_ID` | (lo puso `setup`, no tocar) |

## 3. Publicar como aplicación web

1. **Implementar → Nueva implementación**.
2. Tipo (⚙️): **Aplicación web**.
3. Configuración:
   - **Ejecutar como:** Yo (tu cuenta).
   - **Quién tiene acceso:** **Cualquier usuario** ← importante (TUU y la PWA
     deben poder llamarla sin login).
4. **Implementar** y copia la **URL de la aplicación web**
   (`https://script.google.com/macros/s/……/exec`).

> Cada vez que edites el código, usa **Implementar → Gestionar implementaciones →
> editar (✏️) → Nueva versión**, para que los cambios queden en la misma URL.

## 4. Conectar la PWA

Pásame esa **URL de la aplicación web**. La pego en `index.html`
(constante `BACKEND_URL`) y el botón "IR A PAGAR" pasa a crear el cobro real.

## 5. Probar (sandbox)

1. Abre la PWA, completa una reserva y pulsa **IR A PAGAR**.
2. Te redirige al checkout de TUU. Paga con una **tarjeta de prueba** de TUU.
3. Verifica:
   - Vuelves a la PWA con la pantalla de "reserva confirmada".
   - Llega correo al cliente y a `nosectm@gmail.com`.
   - En la planilla, la fila cambia de `pendiente` a `pagada`.

## 6. Pasar a producción (cuando todo funcione)

En producción TUU usa **RUT + clave secreta**, que el backend intercambia
automáticamente por `account_id` + `secret_key` (vía `/token` y `/validatetoken`).

En **Propiedades del script** agrega/cambia:
- `TUU_ENV` → `prod`
- `RUT_COMERCIO` → el RUT de tu comercio (formato `12345678-9`)
- `CLAVE_SECRETA` → tu clave secreta real de TUU

> La clave secreta la escribes **tú** directamente aquí; nunca la compartas por chat.
> Mientras existan `RUT_COMERCIO` + `CLAVE_SECRETA`, el backend ignora
> `TUU_ACCOUNT_ID`/`TUU_SECRET` y usa el intercambio de producción.

Luego ejecuta la función **`probarCredencialesProd`** y revisa el registro: debe
mostrar el **nombre de tu comercio**, el `account_id` y `activo: 1`. Si aparece,
las credenciales están correctas. Finalmente publica una **nueva versión** de la
implementación y haz una reserva de prueba real (cargo real, reembolsable).

---

### Notas técnicas (para Claude / mantenimiento)

- **Firma TUU:** `ksort` de todo el payload, concatenar solo los pares cuya clave
  empieza con `x_` (`clave+valor`, sin separadores), `HMAC-SHA256` con `TUU_SECRET`,
  hex. Misma fórmula para firmar el request y para validar el webhook.
- **Crear cobro:** POST JSON al endpoint de TUU con los campos `x_*` + `platform`,
  `paymentMethod:"webpay"`, `secret:"18756627"` (constante de plataforma, no del
  comercio), `dte_type:48` y `dte`. Respuesta 200 = **la URL de pago en texto plano**.
- **Webhook:** TUU hace POST a `x_url_callback` (este mismo script) con
  `x_result` ∈ {completed, failed, pending}. Responder 200 siempre; idempotente por
  `x_reference`.
- **Etapa 2b:** habilitar `escribirReservaEnFirestore()` en `confirmarReservaPagada()`,
  usando una cuenta de servicio del proyecto `vive-quintay-spa`.
