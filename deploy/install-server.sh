#!/usr/bin/env bash
#
# Instala el panel web de CPS Security en la Raspberry (ServidorCPS).
#
#   sudo bash /home/servidorcps/SistemaCPS/web/deploy/install-server.sh
#
# ES IDEMPOTENTE: se puede correr de nuevo sin duplicar nada ni rotar secretos.
# Lee los valores de `web/deploy/produccion.env`, que se generó una sola vez.
#
# QUÉ TOCA, y qué NO
# ------------------
# Toca: la base `cpssecurityarg` (la crea), tres roles de Postgres, dos units de
# systemd, un archivo nuevo de nginx y el `.env` del GtD (le agrega dos líneas).
#
# NO toca: el sitio `cpssecurity.com.ar` —es otro server block, en otro archivo—,
# ni mosquitto, ni el `broker-bridge`, ni el listener 1883 de los paneles. Si
# algo sale mal, nginx no se recarga con una config rota: `nginx -t` corre antes.
#
# Lo único destructivo: borra la base vieja `cps_security_monitoring` (esquema
# congelado en la migración 4 de 16, sin datos que valgan — decidido con el
# usuario el 2026-08-06). Antes la respalda en /root/.
set -euo pipefail

RAIZ=/home/servidorcps/SistemaCPS/web
USUARIO=servidorcps
DOMINIO=system.cpssecurity.com.ar
BASE_VIEJA=cps_security_monitoring

paso() { echo; echo "── $* ─────────────────────────────────────────"; }
ok()   { echo "   ✓ $*"; }
malo() { echo "   ✗ $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || malo "Esto va con sudo."
[[ -f $RAIZ/deploy/produccion.env ]] || malo "Falta $RAIZ/deploy/produccion.env"
# shellcheck disable=SC1091
source "$RAIZ/deploy/produccion.env"

: "${DB_NAME:?}" "${DB_PASS_WEB:?}" "${DB_PASS_ALARMS:?}" "${DB_PASS_ADMIN:?}"
: "${DB_PASS_PROVISIONER:?}" "${CRED_KEY:?}" "${OWNER_USER:?}" "${OWNER_PASS:?}"
: "${DB_PASS_LEGACY:?}"

# ═══════════════════════════════════════════════════════════════════
paso "1. Verificaciones previas"
# ═══════════════════════════════════════════════════════════════════
for cmd in node psql nginx certbot systemctl; do
  command -v "$cmd" >/dev/null || malo "falta $cmd"
done
systemctl is-active --quiet postgresql || malo "Postgres no está corriendo"
ok "node $(node -v), postgres y nginx arriba"

# El front y el backend tienen que estar SUBIDOS antes de instalar los units:
# un servicio que arranca sin código queda en un loop de reinicios.
[[ -f $RAIZ/backend/dist/main.js ]] || malo "Falta el backend compilado en $RAIZ/backend/dist"
[[ -f $RAIZ/front/index.html ]]     || malo "Falta el front en $RAIZ/front"
[[ -d $RAIZ/backend/node_modules ]] || malo "Faltan las dependencias: correr npm ci en $RAIZ/backend"
ok "backend, front y dependencias en su lugar"

# ═══════════════════════════════════════════════════════════════════
paso "2. Base de datos y roles"
# ═══════════════════════════════════════════════════════════════════
psqlp() { sudo -u postgres psql -v ON_ERROR_STOP=1 "$@"; }

existe_base() {
  [[ $(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$1'") == 1 ]]
}

# El rol admin es el DUEÑO de la base y el que corre las migraciones. Se usa uno
# propio en vez del superusuario `postgres` para no tocarle la clave a un rol del
# que puede depender otra cosa de la máquina.
# cps_legacy es TEMPORAL: el puente con la app vieja de vecinos. Se saca de esta
# lista el día que se apague, junto con la migración LegacyAppBridge.
for rol in cps_admin cps_web cps_alarms cps_provisioner cps_legacy; do
  case $rol in
    cps_admin)       clave=$DB_PASS_ADMIN ;;
    cps_web)         clave=$DB_PASS_WEB ;;
    cps_alarms)      clave=$DB_PASS_ALARMS ;;
    cps_provisioner) clave=$DB_PASS_PROVISIONER ;;
    cps_legacy)      clave=$DB_PASS_LEGACY ;;
  esac
  psqlp -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$rol') THEN
    CREATE ROLE $rol LOGIN PASSWORD '$clave';
  ELSE
    ALTER ROLE $rol PASSWORD '$clave';
  END IF;
END
\$\$;
SQL
  ok "rol $rol"
done
psqlp -q -c "ALTER ROLE cps_admin CREATEDB"

if existe_base "$DB_NAME"; then
  ok "la base $DB_NAME ya existe"
else
  psqlp -q -c "CREATE DATABASE $DB_NAME OWNER cps_admin"
  ok "base $DB_NAME creada"
fi

# La vieja: primero el respaldo, después el borrado. Decidido con el usuario.
if existe_base "$BASE_VIEJA"; then
  respaldo=/root/${BASE_VIEJA}-$(date +%Y%m%d-%H%M%S).sql.gz
  sudo -u postgres pg_dump "$BASE_VIEJA" | gzip > "$respaldo"
  chmod 600 "$respaldo"
  psqlp -q -c "DROP DATABASE $BASE_VIEJA"
  ok "base vieja respaldada en $respaldo y borrada"
fi

# ═══════════════════════════════════════════════════════════════════
paso "3. Migraciones"
# ═══════════════════════════════════════════════════════════════════
# Corren con cps_admin (DDL). La app corre con cps_web, que NO tiene DDL: es la
# regla de un-solo-escritor de §13, y la base la impone sola.
cd "$RAIZ/backend"
# El binario directo y no `npx`: bajo `sudo -u` el HOME sigue siendo el de root,
# y npx querría escribir su caché en /root/.npm — que servidorcps no puede tocar.
sudo -u "$USUARIO" env NODE_ENV=production HOME=/home/$USUARIO \
  ./node_modules/.bin/typeorm -d dist/database/data-source.js migration:run
ok "esquema al día"

# ═══════════════════════════════════════════════════════════════════
paso "4. GRANTs de un-solo-escritor"
# ═══════════════════════════════════════════════════════════════════
# El archivo versionado apunta a la base de desarrollo y asume que las
# migraciones corren como `postgres`. Acá corren como cps_admin y la base se
# llama distinto: las dos sustituciones se hacen a la vista y sobre la marcha,
# para que el archivo del repo siga siendo la fuente de verdad.
#
# Por STDIN y no por `-f archivo`: psql corre como el usuario `postgres`, y un
# temporal creado por root nace 0600 suyo — `postgres` no lo puede leer. Con el
# pipe no hay archivo intermedio que permisar.
sed -e "s/cps_security_v2/$DB_NAME/g" \
    -e "s/FOR ROLE postgres/FOR ROLE cps_admin/g" \
    "$RAIZ/deploy/roles-conexion-v2.sql" \
  | psqlp -q -d "$DB_NAME" -f -
ok "cps_web no escribe device_state; cps_alarms no resuelve eventos"

# ═══════════════════════════════════════════════════════════════════
paso "5. El OWNER de CPS y la geografía"
# ═══════════════════════════════════════════════════════════════════
cd "$RAIZ/backend"
if sudo -u postgres psql -tAq -d "$DB_NAME" -c \
     "SELECT 1 FROM app_user WHERE username='$OWNER_USER'" | grep -q 1; then
  ok "el usuario $OWNER_USER ya existe (no se toca la clave)"
else
  sudo -u "$USUARIO" env NODE_ENV=production HOME=/home/$USUARIO \
    node dist/auth/bootstrap-admin.cli.js "$OWNER_USER" "$OWNER_PASS"
  ok "OWNER $OWNER_USER creado"
fi

# Provincias, departamentos y localidades desde georef. Tarda unos minutos y es
# idempotente; sin esto no se puede dar de alta un cliente ni un barrio.
if [[ $(sudo -u postgres psql -tAq -d "$DB_NAME" -c "SELECT count(*) FROM province") -gt 0 ]]; then
  ok "la geografía ya está cargada"
else
  echo "   … bajando la geografía de georef (tarda unos minutos)"
  sudo -u "$USUARIO" env NODE_ENV=production HOME=/home/$USUARIO \
    node dist/geography/geography-sync.cli.js
  ok "geografía cargada"
fi

# ═══════════════════════════════════════════════════════════════════
paso "6. El servicio del backend"
# ═══════════════════════════════════════════════════════════════════
# `enable --now` NO reinicia un servicio que YA está corriendo, así que un cambio
# en la unit se instalaba y no tomaba hasta el próximo reboot — en silencio. Por
# eso se compara antes: si cambió, se reinicia. Es lo que hace falta para que un
# `ReadWritePaths` nuevo (los firmwares del OTA) tenga efecto.
if ! cmp -s "$RAIZ/deploy/cps-backend.service" /etc/systemd/system/cps-backend.service; then
  install -m 644 "$RAIZ/deploy/cps-backend.service" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable cps-backend.service
  systemctl restart cps-backend.service
  ok "la unit cambió: reinstalada y reiniciada"
else
  systemctl daemon-reload
  systemctl enable --now cps-backend.service
fi
sleep 3
systemctl is-active --quiet cps-backend || {
  journalctl -u cps-backend -n 30 --no-pager
  malo "el backend no arrancó"
}
ok "cps-backend arriba y habilitado al arranque"

# ═══════════════════════════════════════════════════════════════════
paso "7. El certificado y el sitio"
# ═══════════════════════════════════════════════════════════════════
# `system.cpssecurity.com.ar` no entra en los 32 bytes que nginx reserva por
# defecto para la tabla de nombres, y el chequeo falla con un mensaje que no
# menciona el dominio: "could not build server_names_hash". Debian deja la
# directiva comentada en nginx.conf justo para esto; va en conf.d para no
# editar un archivo de la distribución.
if [[ ! -f /etc/nginx/conf.d/server_names_hash.conf ]]; then
  echo 'server_names_hash_bucket_size 64;' > /etc/nginx/conf.d/server_names_hash.conf
  ok "tabla de nombres agrandada a 64 (el dominio no entraba en 32)"
fi

# Huevo y gallina: la config de 443 referencia un certificado que todavía no
# existe, y `nginx -t` falla. Por eso primero va un sitio HTTP mínimo que solo
# sirve para que certbot valide por webroot, y recién después el sitio completo.
if [[ ! -d /etc/letsencrypt/live/$DOMINIO ]]; then
  mkdir -p /var/www/html
  cat > /etc/nginx/sites-available/$DOMINIO <<NGINX
server {
    listen 80;
    server_name $DOMINIO;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 404; }
}
NGINX
  ln -sf /etc/nginx/sites-available/$DOMINIO /etc/nginx/sites-enabled/$DOMINIO
  # `nginx -t && reload` NO sirve acá: con `set -e`, bash ignora el fallo de un
  # comando que no es el último de un `&&`, así que un chequeo fallido seguía de
  # largo y el ✓ mentía. Pasó de verdad el 2026-08-06.
  if ! nginx -t; then
    rm -f /etc/nginx/sites-enabled/$DOMINIO
    malo "la config temporal no valida — se quitó el sitio y no se recargó nada"
  fi
  systemctl reload nginx
  ok "sitio temporal para la validación"

  # Certificado PROPIO del subdominio, no una expansión del de cpssecurity.com.ar:
  # si la renovación de este falla, el sitio institucional no se entera.
  certbot certonly --webroot -w /var/www/html -d "$DOMINIO" \
    --non-interactive --agree-tos --register-unsafely-without-email \
    --deploy-hook "systemctl reload nginx"
  ok "certificado emitido"
else
  ok "el certificado ya existe"
fi

install -m 644 "$RAIZ/deploy/$DOMINIO.conf" /etc/nginx/sites-available/$DOMINIO
ln -sf /etc/nginx/sites-available/$DOMINIO /etc/nginx/sites-enabled/$DOMINIO
# nginx necesita atravesar el home para leer el front.
chmod o+x /home/servidorcps /home/servidorcps/SistemaCPS /home/servidorcps/SistemaCPS/web
chmod -R o+rX "$RAIZ/front"
nginx -t || malo "la config de nginx no valida — NO se recargó, el sitio viejo sigue igual"
systemctl reload nginx
ok "https://$DOMINIO sirviendo"

# ── La carpeta de los firmwares (OTA) ────────────────────────────────
# La escribe el backend (como $USUARIO) y la LEE nginx, pero desde el server
# block del APEX: el firmware valida el host exacto `cpssecurity.com.ar` y
# rechaza `system.` antes de bajar un byte. Ese archivo NO se toca acá — es el
# sitio institucional. Lo que sí se puede dejar listo es la carpeta.
FIRMWARE_DIR=$RAIZ/firmware
mkdir -p "$FIRMWARE_DIR/alarmavecinal/ota"
chown -R "$USUARIO:$USUARIO" "$FIRMWARE_DIR"
chmod -R o+rX "$FIRMWARE_DIR"
ok "carpeta de firmwares en $FIRMWARE_DIR"

if ! grep -q '^FIRMWARE_ROOT=..*' "$RAIZ/backend/.env" 2>/dev/null; then
  echo "   ⚠ falta FIRMWARE_ROOT en $RAIZ/backend/.env — agregá:"
  echo "       FIRMWARE_ROOT=$FIRMWARE_DIR"
  echo "     Sin eso la pantalla de actualizaciones no puede subir ningún .bin."
fi

if ! grep -rq 'location /firmware/' /etc/nginx/sites-enabled/ 2>/dev/null; then
  echo "   ⚠ nginx todavía no sirve /firmware/ en el apex cpssecurity.com.ar."
  echo "     Pegá el bloque de $RAIZ/deploy/apex-firmware.conf adentro del"
  echo "     server{ listen 443 } del sitio institucional y recargá."
  echo "     Sin eso los equipos bajan un 404 al actualizar."
fi

# ═══════════════════════════════════════════════════════════════════
paso "8. El GtD deja de tirar todo a la basura"
# ═══════════════════════════════════════════════════════════════════
# Hasta ahora corría con GTD_PG_DSN vacío, o sea StubRepo: validaba, logueaba y
# no persistía NADA. Se le agregan las claves que le faltan SIN pisar lo que ya
# tiene (la password del broker se generó al instalarlo y está registrada en
# mosquitto: perderla es dejar al GtD afuera).
GTD_ENV=/home/servidorcps/SistemaCPS/gateway-to-device/.env
poner() {  # poner CLAVE VALOR — agrega si falta, reemplaza si está vacía
  local k=$1 v=$2
  if grep -qE "^$k=.+" "$GTD_ENV"; then
    ok "$k ya tenía valor (no se toca)"
  elif grep -qE "^$k=" "$GTD_ENV"; then
    sed -i "s|^$k=.*|$k=$v|" "$GTD_ENV"; ok "$k completada"
  else
    printf '%s=%s\n' "$k" "$v" >> "$GTD_ENV"; ok "$k agregada"
  fi
}
poner GTD_PG_DSN "postgresql://cps_alarms:$DB_PASS_ALARMS@127.0.0.1:5432/$DB_NAME"
poner GTD_CRED_KEY "$CRED_KEY"
poner GTD_PROVISIONER_DSN "postgresql://cps_provisioner:$DB_PASS_PROVISIONER@127.0.0.1:5432/$DB_NAME"
chown "$USUARIO:$USUARIO" "$GTD_ENV"; chmod 600 "$GTD_ENV"
systemctl restart gateway-to-device
sleep 2
systemctl is-active --quiet gateway-to-device || malo "el GtD no volvió a arrancar"
ok "GtD reiniciado y persistiendo en $DB_NAME"

# ═══════════════════════════════════════════════════════════════════
paso "9. El provisioner"
# ═══════════════════════════════════════════════════════════════════
install -m 644 /home/servidorcps/SistemaCPS/gateway-to-device/deploy/cps-provisioner.service \
  /etc/systemd/system/
systemctl daemon-reload
if grep -qE "^GTD_SALT_MQTT=.+" "$GTD_ENV"; then
  systemctl enable --now cps-provisioner.service
  ok "cps-provisioner arriba y habilitado"
else
  # Sin los salts NO se habilita: arrancaría, no podría derivar una sola
  # credencial y quedaría reintentando contra la cola. Peor que apagado, porque
  # parece que anda.
  systemctl disable cps-provisioner.service 2>/dev/null || true
  echo "   ! cps-provisioner INSTALADO PERO APAGADO: falta GTD_SALT_MQTT en $GTD_ENV"
  echo "     Completá los tres salts y después:"
  echo "       sudo systemctl enable --now cps-provisioner"
fi

# ═══════════════════════════════════════════════════════════════════
paso "10. Verificación"
# ═══════════════════════════════════════════════════════════════════
echo
for u in cps-backend gateway-to-device mosquitto postgresql nginx; do
  printf '   %-22s %s / arranque: %s\n' "$u" \
    "$(systemctl is-active $u 2>/dev/null)" "$(systemctl is-enabled $u 2>/dev/null)"
done
echo
echo "   API local:  $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api)"
echo "   Sitio:      $(curl -s -o /dev/null -w '%{http_code}' https://$DOMINIO)"
echo
echo "════════════════════════════════════════════════════════════════"
echo "  Listo: https://$DOMINIO"
echo "  Entrás con el usuario $OWNER_USER y la clave que está en"
echo "  $RAIZ/deploy/CREDENCIALES.txt  (guardala y borrá el archivo)"
echo "════════════════════════════════════════════════════════════════"
