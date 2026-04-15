## Qué cambia este PR

1-3 líneas explicando el cambio desde la perspectiva del usuario o del sistema. No describas el diff — describí el efecto.

**Mal:** "Agregué un middleware express-rate-limit en server.js"
**Bien:** "Bloquea brute force sobre /api/auth/login limitando a 10 intentos cada 15 min"

## Por qué

El motivo real del cambio. Si viene de un issue, linkealo (`closes #42`). Si es proactivo, explicá qué problema te anticipaste.

## Cómo lo probaste

Marcá lo que aplique y describí lo hecho:

- [ ] Unit tests (agregué / actualicé tests existentes)
- [ ] Smoke test manual (describí pasos)
- [ ] Playwright MCP end-to-end
- [ ] Probé en producción / droplet staging
- [ ] Solo cambios de docs — no aplica

## Checklist

- [ ] El commit message sigue el estilo del repo (`tipo(scope): mensaje en minúsculas`)
- [ ] Actualicé docs relevantes si el cambio lo requiere (`README.md`, `docs/TODO-deploy.md`, `docs/runbook-deploy.md`, `CONTRIBUTING.md`, `docs/adaptacion.md`)
- [ ] No estoy commiteando secretos ni archivos generados (`node_modules/`, `.env`, `prisma/*.db`)
- [ ] Si cambié dependencias, corrí `npm audit --omit=dev` y no hay nuevos CVEs críticos
- [ ] Si agregué una env var nueva, la documenté en `.env.example` y `docs/env.example.clean`
- [ ] Si tocó código del flujo de pagos, los 5 tests del webhook (del commit `security(compras)`) siguen pasando

## Riesgo + reversibilidad

- **Riesgo de romper producción:** [ ] nulo · [ ] bajo · [ ] medio · [ ] alto (si es alto, describir mitigación)
- **¿Requiere migración de datos?** [ ] no · [ ] sí (describir cómo)
- **¿Requiere rotar secrets o cambiar config del droplet?** [ ] no · [ ] sí (describir cuál)

## Notas para el reviewer

Cualquier cosa que valga la pena comentar antes de que alguien se tire a leer el diff. Ej. "la función X parece duplicar a Y pero no lo es porque Z", "dejé un TODO intencional en la línea N", "hay un edge case que no cubrí porque es improbable en nuestro uso".

---

*Si es tu primer PR al repo, bienvenidx. Recomendamos leer [`CONTRIBUTING.md`](CONTRIBUTING.md) antes de pedir review.*
