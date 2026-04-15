# Contribuir a SAB Landing

Este repo existe principalmente para que el SAB tenga su ticketera propia + para que otras cooperativas musicales puedan forkearlo. **Contribuciones externas son bienvenidas** siempre que apunten a estos dos objetivos.

## Tipos de contribución que encajan

- **Bugs reportados o arreglados** — si encontrás algo roto usándolo, abrí un issue con el template `Bug report`.
- **Fixes de seguridad** — si descubrís una vulnerabilidad, **NO abras un issue público**: escribime directo a martinlleral@gmail.com con detalle y le damos coordenada privada.
- **Mejoras genéricas** que otras cooperativas también van a aprovechar — ej. rate limiting, backups, monitoring, mejores tests.
- **Docs** — especialmente si encontrás un paso que no funciona como está documentado, o si pudiste forkear y querés agregar aprendizajes a `docs/adaptacion.md`.
- **Traducciones** de la landing a otros idiomas (portugués, inglés) — el SAB no las necesita, pero una cooperativa brasilera o de habla inglesa sí.

## Tipos de contribución que NO encajan

- **Cambios específicos del SAB** (colores, textos, fotos de la banda) — eso lo hacemos directo en la rama principal, no vía PR.
- **Features nuevas grandes sin discusión previa** (ej. "agregar soporte para Stripe", "migrar a TypeScript", "reescribir el backoffice en React") — mejor abrí un issue primero para charlarlo. Si tiene sentido lo implementamos, pero no queremos merging blind de refactors que no pedimos.
- **Dependency bumps automáticos** tipo Dependabot sin justificación — aceptados solo para fixes de CVE, no por "hay una versión nueva".

## Antes de mandar un PR

1. **Abrí un issue primero** si el cambio no es trivial (>30 líneas o toca más de 2 archivos). Evita PRs rechazados por "no es el approach que queríamos".
2. **Una cosa por PR** — si tenés 3 fixes, mandalos en 3 PRs separados. Más fácil de revisar, más fácil de revertir si uno rompe algo.
3. **Commits con mensajes descriptivos** — leé `git log --oneline` para ver el estilo: `tipo(scope): mensaje en minúsculas`. Ejemplo: `security(compras): hardening del flujo de pagos`.
4. **Documentá tu cambio** — si tocás código, actualizá el README / TODO-deploy / runbook-deploy si corresponde. Si es un fix de seguridad importante, anotalo en `docs/WORKFLOW-LEARNINGS.md`.

## Cómo correr el código localmente

Ver [`README.md#correr-en-local`](README.md#correr-en-local). Tl;dr:

```bash
git clone git@github.com:martinlleral/sab-landing.git
cd sab-landing
cp .env.example .env
# Editar .env con credenciales de test
docker compose up -d
```

## Tests

**No hay test suite automatizada todavía.** Las validaciones se hacen:

1. **Con Playwright MCP** para flujos end-to-end críticos (ver `docs/auditoria-playwright-20260410.md` como ejemplo).
2. **Unit tests ad-hoc con `node -e`** para funciones puras como `verifyMpSignature()` — ver los commits `security(compras): hardening del flujo de pagos` como ejemplo de patrón.
3. **Smoke tests manuales** post-deploy siguiendo el runbook.

**Si querés agregar una test suite de verdad** (Vitest, Playwright test runner), eso sería una contribución excelente — abrí issue primero para acordar el approach antes de mandar el PR.

## Código de conducta

- Tratá a todo el mundo con respeto. Los proyectos cooperativos se construyen con gente heterogénea en edad, formación técnica, identidad de género, origen — mantené el tono bajo y cálido en issues y PRs.
- Criticá el código, no a la persona. "Este approach tiene X problema" es distinto de "quién escribió esto no sabe programar".
- Si alguien nuevo pregunta algo básico, respondé con el mismo cuidado con el que querrías que te respondan cuando vos llegaste a tu primer proyecto open source.
- No se aceptan comportamientos hostiles, discriminatorios o agresivos. Sin necesidad de tener un documento de CoC largo, la línea es simple: si no lo dirías mirando a la persona a los ojos, no lo escribas acá.

## Créditos y atribución

Si tu PR es merged, tu nombre va a aparecer en el `git log` y en los créditos del commit. No llevamos una lista aparte de contribuidores — el historial de git es la fuente de verdad. Si preferís que se te reconozca con un nombre distinto al de tu cuenta GitHub, indicarlo en el PR.

## Licencia

Al contribuir aceptás que tu código se licencia bajo MIT License, la misma del resto del repo. Ver `LICENSE`.

---

Dudas, propuestas o "¿esto encaja?" → abrí un issue o escribime a martinlleral@gmail.com.
