# Reservas — Vive Quintay SpA

PWA de reservas de estacionamiento. El cliente escanea un QR en el letrero → WhatsApp
(bot envía el link) → esta PWA → reserva su día → paga en TUU → la reserva queda
confirmada y, el día indicado, la patente aparece en caja taggeada como **Pagada**.

## Estado actual

- ✅ **PWA visual** (flujo de 3 pantallas): patente universal → datos + calendario + tramo → resumen y pago.
- ⏳ **Pago TUU**: pendiente (siguiente etapa). El botón "IR A PAGAR" hoy es un placeholder.
- ⏳ **Backend (Google Apps Script)**: pendiente. Creará el Payment Intent en TUU, recibirá
  el webhook firmado, escribirá la reserva como "Pagada" en Firestore y enviará los correos.
- ⏳ **Materialización en caja**: el programa de escritorio leerá las reservas pagadas del día.

## Arquitectura

```
Letrero QR → WhatsApp (bot envía link) → PWA
  PWA: patente → datos + fecha + tramo → resumen
     → [backend Apps Script crea Payment Intent en TUU] → pasarela TUU
        → pago OK → TUU POST firmado a Apps Script (webhook)
           → valida firma HMAC-SHA256
           → escribe reservas/{id} estado "Pagada" en Firestore (vía service account)
           → correo a Vive Quintay SpA + correo de confirmación al cliente
  Caja: al abrir, materializa las reservas pagadas del día en activos/{patente}
```

## Reglas clave

- **Solo se reserva contra pago.** No hay reserva por tiempo: se paga y queda el día.
- El **monto** ($4.000 CLP, editable) vive en Firestore `config/reservas` y lo lee el backend
  (nunca el cliente → no se puede adulterar).
- El estado **"Pagada"** lo escribe **solo el backend** tras validar la firma del webhook de TUU.

## Configuración (Firestore `config/reservas`)

Documento opcional; si no existe, la PWA usa valores por defecto.

```json
{
  "precio": 4000,
  "dias_semana": [0,1,2,3,4,5,6],
  "fechas_bloqueadas": ["2026-09-18"],
  "tramos": ["12:00 - 13:00", "14:00 - 15:00"]
}
```

`dias_semana`: 0=domingo … 6=sábado. `fechas_bloqueadas`: feriados/cerrado puntuales.

## Tecnología

HTML/JS vanilla + Firebase v8 (CDN), igual que el Verificador. PWA con manifest + service worker.
