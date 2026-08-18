#!/usr/bin/env bash
#
# verificar-credenciales-mp.sh
#
# Responde una sola pregunta: ¿de qué cuenta de Mercado Pago es este Access Token?
# Correlo SIEMPRE antes de poner un token nuevo en producción.
#
# Por qué existe: el 14/8/2026, al migrar el cobro a la cuenta de la cooperativa,
# nos pasaron credenciales que arrancaban con APP_USR- y venían de la solapa
# "producción"... pero eran de un usuario de prueba del sandbox. El prefijo
# APP_USR- NO distingue producción de prueba: Checkout Pro, Orders API, Point y QR
# lo usan para ambas. El único dato confiable es lo que responde /users/me.
#
# Uso:
#   ./verificar-credenciales-mp.sh                    # pide el token sin dejarlo en el historial
#   ./verificar-credenciales-mp.sh <ACCESS_TOKEN>
#   ./verificar-credenciales-mp.sh <ACCESS_TOKEN> <ID_ESPERADO>   # además exige que sea esa cuenta
#
# Salida: exit 0 = APTO para producción · exit 1 = NO APTO (con el motivo)
#
set -uo pipefail

TOKEN="${1:-}"
ID_ESPERADO="${2:-}"

if [[ -z "$TOKEN" ]]; then
  read -r -s -p "Pegá el Access Token (no se va a mostrar): " TOKEN
  echo
fi

if [[ -z "$TOKEN" ]]; then
  echo "✖  No ingresaste ningún token."
  exit 1
fi

RESPUESTA=$(curl -s -w $'\n%{http_code}' -H "Authorization: Bearer $TOKEN" \
  https://api.mercadopago.com/users/me)
HTTP_CODE=$(printf '%s' "$RESPUESTA" | tail -1)
CUERPO=$(printf '%s' "$RESPUESTA" | sed '$d')

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "✖  NO APTO — Mercado Pago rechazó el token (HTTP $HTTP_CODE)."
  echo "   Puede estar mal copiado, vencido o revocado."
  exit 1
fi

# El prefijo es informativo en una sola dirección: TEST- es SIEMPRE de sandbox,
# mientras que APP_USR- no distingue nada (lo usan prueba y producción por igual).
# Un token TEST- puede pertenecer a una cuenta real y aun así no cobrar un peso.
PREFIJO_TEST=0
[[ "$TOKEN" == TEST-* ]] && PREFIJO_TEST=1

ID_ESPERADO="$ID_ESPERADO" PREFIJO_TEST="$PREFIJO_TEST" python3 - "$CUERPO" <<'PY'
import json, os, sys

d = json.loads(sys.argv[1])
esperado = os.environ.get("ID_ESPERADO", "").strip()
prefijo_test = os.environ.get("PREFIJO_TEST") == "1"

uid      = str(d.get("id", ""))
email    = d.get("email", "") or ""
nickname = d.get("nickname", "") or ""
tags     = d.get("tags", []) or []
site     = d.get("site_id", "")

# --- Señales de cuenta de prueba. Cualquiera alcanza para frenar el deploy. ---
motivos = []
if "test_user" in tags:
    motivos.append('la cuenta tiene el tag "test_user"')
if email.endswith("@testuser.com"):
    motivos.append("el mail es del dominio @testuser.com")
if nickname.upper().startswith("TESTUSER"):
    motivos.append('el nickname arranca con "TESTUSER"')

print(f"  Cuenta    : {email}")
print(f"  Nickname  : {nickname}")
print(f"  User ID   : {uid}        <- este es el collector_id")
print(f"  País      : {site}")
print(f"  Tags      : {', '.join(tags) if tags else '(ninguno)'}")
print()

if motivos:
    print("✖  NO APTO — esto es una CUENTA DE PRUEBA del sandbox.")
    for m in motivos:
        print(f"   · {m}")
    print()
    print("   Con estas credenciales nadie puede comprar una entrada de verdad.")
    print("   Quien las generó tiene que salir de la cuenta de prueba y entrar")
    print("   con la cuenta real (la que tiene el CBU donde cae la plata).")
    sys.exit(1)

if prefijo_test:
    print("✖  NO APTO — la cuenta es real, pero el token es de SANDBOX.")
    print('   Arranca con "TEST-", que siempre indica credenciales de prueba.')
    print("   Buscá el Access Token en la solapa Credenciales de producción.")
    print()
    print("   (Al revés no vale: que arranque con APP_USR- no prueba nada,")
    print("    porque Checkout Pro usa ese prefijo también para las de prueba.)")
    sys.exit(1)

if esperado and uid != esperado:
    print(f"✖  NO APTO — el token es de la cuenta {uid}, y esperábamos {esperado}.")
    print("   Si es un cambio de cuenta buscado, actualizá el ID esperado a mano.")
    sys.exit(1)

if site != "MLA":
    print(f"⚠  Ojo: la cuenta es de {site}, no de Argentina (MLA). Verificá que sea correcto.")

print("✔  APTO — es una cuenta real de Mercado Pago.")
print()
print("   Antes de deployar, confirmá a ojo que el mail de arriba sea el de la")
print("   cooperativa. Que la cuenta sea real no prueba que sea la correcta.")
sys.exit(0)
PY
