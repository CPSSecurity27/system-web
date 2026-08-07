# Despliegue del panel web — `system.cpssecurity.com.ar`

El servidor es la misma Raspberry que ya corre mosquitto, el GtD, el
`broker-bridge` y Postgres (`ServidorCPS`, Raspbian 13, **921 MB de RAM**). El
sitio institucional `cpssecurity.com.ar` vive ahí también y **no se toca**: el
panel entra como un server block aparte, en su propio archivo y con su propio
certificado.

## Cómo queda

```
                          :443  nginx
                            │
        ┌───────────────────┴───────────────────┐
        │ /api/  → 127.0.0.1:3000 (cps-backend) │
        │ /      → /web/front (Angular, SPA)    │
        └───────────────────────────────────────┘
                            │
                     Postgres 17 (127.0.0.1)
                            │
        ┌───────────────────┴──────────────────┐
        │ gateway-to-device   (MQTT ↔ base)    │
        │ cps-provisioner     (broker ↔ base)  │
        └──────────────────────────────────────┘
```

**El front y la API salen del mismo origen.** No es un detalle de comodidad: así
no hay CORS, el backend no queda expuesto en un puerto propio a internet, y el
`environment.production.ts` puede usar `apiUrl: '/api'` — el día que cambie el
dominio no hay que recompilar nada.

## Actualizar

Desde esta máquina, con el repo compilado:

```bash
# 1. compilar
cd frontend-angular && npx ng build --configuration production
cd ../backend-nestjs && npm run build

# 2. armar y subir el paquete (el script del scratchpad hace las dos cosas)
#    front → web/front, dist → web/backend/dist

# 3. si cambiaron las dependencias del backend
ssh ServidorCPS 'cd ~/SistemaCPS/web/backend && npm ci --omit=dev'

# 4. reiniciar
ssh -t ServidorCPS 'sudo systemctl restart cps-backend'
```

El front es estático: con copiarlo alcanza, no hay que reiniciar nada.

## La primera vez

```bash
ssh -t ServidorCPS 'sudo bash ~/SistemaCPS/web/deploy/install-server.sh'
```

`-t` es necesario para que `sudo` pueda pedir la contraseña: en esta Raspberry
**no hay reglas `NOPASSWD`**, así que nada de esto se puede automatizar desde
afuera.

El script es **idempotente** y hace, en orden: roles y base (`cpssecurityarg`),
migraciones con el rol admin, GRANTs de un-solo-escritor, OWNER y geografía,
unit del backend, certificado y sitio de nginx, `.env` del GtD, unit del
provisioner, y una verificación final.

Lo único destructivo: borra la base vieja `cps_security_monitoring` —esquema
congelado en la migración 4 de 16, sin datos que valgan— **después de
respaldarla** en `/root/`.

## Los tres roles de Postgres, y por qué son tres

| rol | quién | qué puede |
|---|---|---|
| `cps_admin` | las migraciones | DDL. Dueño de la base. |
| `cps_web` | la API | todo menos escribir `device_state` y tocar lo append-only |
| `cps_alarms` | el GtD | lee configuración; escribe estado y eventos |
| `cps_provisioner` | el provisioner | solo la cola de provisioning |

La regla de **un solo escritor por tabla** no depende de la disciplina de nadie:
la impone la base con GRANTs (§13 del esquema). Por eso la app no corre con el
rol que hace las migraciones.

Se usa `cps_admin` y no el superusuario `postgres` para no cambiarle la clave a
un rol del que puede depender otra cosa de la máquina. Como las migraciones
corren con él, el `ALTER DEFAULT PRIVILEGES` del script de roles se sustituye a
`FOR ROLE cps_admin` — si no, cada tabla nueva nacería invisible para `cps_web`.

## Arranque automático

Los cuatro servicios quedan `enabled`: si la Pi se reinicia, vuelven solos.

| unit | qué es | orden |
|---|---|---|
| `postgresql` | la base | primero |
| `mosquitto` | el broker | |
| `gateway-to-device` | el puente MQTT | `After=mosquitto` |
| `cps-provisioner` | credenciales en el broker | `After=mosquitto postgresql` |
| `cps-backend` | la API | `After=postgresql` |
| `nginx` | el frente | |

`cps-backend` tiene `MemoryMax=320M`. La Pi tiene 921 MB y encima corre Postgres
y el broker: un backend que se desmadre no puede llevarse el broker puesto, que
es lo único que no puede faltar — sin él, los paneles no reportan.

## Lo que hay que completar a mano

Los **tres salts** del provisioner, en el `.env` del GtD. No se pueden generar:
`GTD_SALT_TEC` y `GTD_SALT_CPS` tienen que ser idénticos a los compilados en el
firmware (`wifi_secrets.local.h`). Sin ellos, el provisioner queda instalado
pero **apagado a propósito** — arrancarlo sin salts sería peor que tenerlo
apagado, porque parecería que anda mientras falla contra cada fila de la cola.

Consecuencia mientras tanto: **no se pueden fabricar equipos nuevos**. El alta de
fábrica es atómica y si el provisioner no confirma, el equipo se borra. Todo lo
demás del sistema funciona.

## Verificar

```bash
ssh ServidorCPS 'systemctl is-active cps-backend gateway-to-device nginx postgresql'
ssh ServidorCPS 'journalctl -u cps-backend -n 50 --no-pager'
curl -s -o /dev/null -w '%{http_code}\n' https://system.cpssecurity.com.ar
```
