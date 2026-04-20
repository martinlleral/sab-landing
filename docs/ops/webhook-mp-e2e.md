# Runbook — validación end-to-end del webhook MercadoPago

**Objetivo:** verificar que los **3 caminos** hacia `procesarPagoAprobado()` están vivos en producción antes de la campaña del 1/5.

Los 3 caminos (defense in depth):
1. **Webhook HTTP firmado** — MP llama a `POST /api/compras/webhook` con firma HMAC-SHA256
2. **Polling del cliente** — el modal post-redirect llama a `GET /api/compras/check/:preferenciaId`
3. **Cron de 60s** — `syncPagosPendientes()` barre compras `pending` cada minuto

Si los 3 están vivos, perder 1 o 2 no pierde ventas (las compras legítimas se procesan igual).

---

## Pre-check (5 min)

### P1. Verificar que el cron está vivo

```bash
ssh sab@162.243.172.177 'docker logs sab-app --since 3m 2>&1 | grep -c "Sync pagos MP"'
```

Debe devolver un número ≥ 1 (el cron corre cada 60s). Si devuelve `0` → el cron está muerto, **detener runbook e investigar**.

### P2. Verificar que la app está corriendo con las vars MP

```bash
ssh sab@162.243.172.177 'docker exec sab-app printenv | grep -iE "MP_|NODE_ENV" | sed "s/=.*/=***/"'
```

Debe mostrar al menos: `MP_ACCESS_TOKEN=***`, `MP_PUBLIC_KEY=***`, `MP_WEBHOOK_SECRET=***`, `MP_USER_ID=***`.

### P3. Verificar que el endpoint webhook responde (sin firma → 401)

```bash
curl -sI -X POST https://sindicatoargentinodeboleros.com.ar/api/compras/webhook \
  -H 'Content-Type: application/json' -d '{}'
# Esperado: HTTP/2 401 (firma inválida)
# Si fuera 503 → falta MP_WEBHOOK_SECRET en .env del droplet.
```

---

## Test E2E (15 min, manual)

### E1. Levantar monitor de logs en tiempo real

En una terminal dedicada:

```bash
ssh sab@162.243.172.177 'docker logs -f sab-app --since 1m 2>&1 | grep -iE "webhook|Sync|procesarPagoAprobado|✅|WARN|ERROR"'
```

Dejarla abierta durante todo el test.

### E2. Hacer una compra real con tarjeta de prueba MP

1. Abrir https://sindicatoargentinodeboleros.com.ar/ en incógnito.
2. Click en el botón de compra del evento destacado.
3. Completar datos: email de prueba, nombre, apellido, teléfono, 1 entrada.
4. Click "Ir a pagar" → redirige a MP.
5. En el checkout de MP, usar una **tarjeta de prueba**:

| Campo | Valor |
|---|---|
| Tarjeta | `5031 7557 3453 0604` (Mastercard) |
| Titular | `APRO` (todo en mayúsculas — fuerza estado **aprobado**) |
| Vencimiento | `11/30` |
| CVV | `123` |
| DNI | `12345678` |

> Docs oficiales: https://www.mercadopago.com.ar/developers/es/docs/checkout-pro/additional-content/your-integrations/test/cards

6. Confirmar el pago. MP redirige de vuelta al sitio con query params `?status=approved&preference_id=...`.
7. El modal debería mostrar "✅ Compra confirmada, revisá tu mail".

### E3. Observar cuál camino disparó (monitor E1)

Mirar el log que abriste en E1. Deberías ver uno de estos patrones:

**Patrón A — webhook HTTP disparó primero (ideal):**
```
[webhook MP] (sin warns previos)
✅ Compra #N aprobada — 1 entrada(s) generada(s) (pago P)
```
Tiempo: <5 seg desde el pago.

**Patrón B — polling cliente disparó primero:**
```
(logs del polling)
✅ Compra #N aprobada — 1 entrada(s) generada(s) (pago P)
```
Tiempo: ~10-30 seg (el cliente hace polling cada 3s).

**Patrón C — cron 60s lo agarró:**
```
🔄 Sync pagos MP: X compra(s) pendiente(s)
✅ Compra #N aprobada — 1 entrada(s) generada(s) (pago P)
```
Tiempo: hasta 60 seg.

Si ves `✅ Compra #N aprobada` seguido de `⏭ Compra #N ya estaba procesada` en los otros caminos → **los 3 están vivos y idempotentes**, que es exactamente lo que queremos.

### E4. Verificar que llegó el mail

Revisar la bandeja del email de prueba (y spam). Debe llegar un mail con:
- Subject: `🎟️ Tus entradas para [NOMBRE_EVENTO]`
- 1 QR de entrada
- Datos del evento

Si no llega en 2-3 min → el SMTP o Brevo HTTP falló. Revisar `docs/audit/auditoria-20260420.md` → sección SMTP DO y el smoke `scripts/smoke-mail.js`.

---

## Tests de camino individual (opcional, si querés máxima confianza)

### T1. Simular webhook caído, verificar que el polling o cron procesa

```bash
# Apagar temporalmente el webhook: desactivarlo en el panel MP
# (o bloquearlo con iptables en el droplet, pero más arriesgado)
# Hacer una compra con tarjeta APRO
# Esperar 60-90 seg
# Verificar en logs que el cron lo procesó
```

### T2. Simular cron caído, verificar que el webhook procesa

```bash
ssh sab@162.243.172.177 'docker exec sab-app kill -STOP 1' # NO HACER — mata la app
# Alternativa segura: modificar syncPagos.js para early-return temporalmente,
# hacer deploy, hacer compra, ver que el webhook la procesó, revertir deploy.
```

T1 y T2 son más invasivos — solo si hay presupuesto de tiempo y entorno de staging.

---

## Post-test

### Si los 3 caminos funcionaron

✓ Dejar constancia en `docs/audit/auditoria-20260420.md` → sección "Gaps de campaña" → marcar webhook como validado.

### Si alguno falló

Según qué falló:

| Síntoma | Diagnóstico probable | Fix |
|---|---|---|
| Webhook no aparece en logs | MP no encuentra la URL / secreto mal | Panel MP → Webhooks → URL debe ser `https://sindicatoargentinodeboleros.com.ar/api/compras/webhook` y firmada con el mismo secret del `.env` |
| Webhook 401 firma inválida | `MP_WEBHOOK_SECRET` no coincide con el panel | Regenerar en MP → copiar al `.env` → restart del contenedor |
| Polling nunca vuelve | El cliente no reconoce el redirect | Revisar `public/assets/js/checkout.js` y el query handler |
| Cron no procesa | `mpService.buscarPagoPorCompra` falla | Revisar `MP_ACCESS_TOKEN` válido + logs con `❌` |
| `amount mismatch` warn | Precio en DB ≠ precio pagado | Probable compra de prueba con monto alterado. Investigar compra individual. |

### Cleanup de compras de prueba

Si el test dejó compras "aprobadas" en la DB de prod (porque usaste tarjeta APRO), marcarlas manualmente como test o eliminarlas:

```bash
ssh sab@162.243.172.177 'docker exec sab-app sh -c "cd /app && npx prisma studio"'
# Abrir en browser via SSH tunnel, buscar la compra por email de prueba, eliminar.
```

O por SQL directo desde el contenedor, pero solo si ya sabés qué compra querés borrar — en prod no hay rollback automático.

---

*Versión 1.0 — 20/4/2026. Ejecutar al menos 1 vez antes del 28/4.*
