---
name: Bug report
about: Algo no funciona como esperabas
title: '[BUG] '
labels: bug
assignees: ''
---

## ¿Qué esperabas que pasara?

Describí el comportamiento esperado en 1-2 líneas. No incluyas capturas de pantalla acá — eso va abajo.

## ¿Qué pasó realmente?

Describí el comportamiento actual. Si hay un error visible (mensaje, código HTTP, pantalla en blanco), copialo textual.

## Pasos para reproducirlo

1.
2.
3.

Cuantos más específicos, mejor. Si requiere datos particulares en la DB (ej. un evento con `esExterno=true`), mencionalo.

## Entorno

- **Dónde pasó:** [ ] local (Docker)  · [ ] producción  · [ ] fork de otra cooperativa
- **Browser / OS:** (ej. Firefox 124 en Ubuntu 24.04, Chrome en Android 14)
- **Commit o rama:** `git log -1 --oneline` o link al commit en GitHub
- **URL afectada:** (ej. `/api/compras/webhook`, `/#sumate`, `/backoffice/eventos`)

## Logs relevantes

Si tenés acceso a los logs del container:

```
docker compose logs sab-app --tail 50
```

Pegá acá las últimas líneas relevantes. **Si hay algún secret** (access token, password, email privado), reemplazalo con `<REDACTED>` antes de pegar.

## Capturas o video

Si el bug es visual, una captura ayuda mucho. Si es un flujo (click → error), un GIF o video corto.

## ¿Tenés idea de la causa?

Opcional. Si el bug te sonó a algo específico ("parece CORS", "parece un race condition en el seed"), compartilo. Si no, dejalo vacío — no hace falta diagnóstico para reportar.

## ¿Te bloquea?

- [ ] Sí, no puedo usar el sistema
- [ ] Medio — puedo trabajar alrededor, pero es molesto
- [ ] No, es un nice-to-have
