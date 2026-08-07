# OTA — actualización de firmware

> Estado: **implementado el 2026-08-06**, salvo el paso de nginx que necesita
> sudo en el servidor (§6) y el mecanismo de actualizaciones pendientes (§7).

## 1. Hay DOS OTA y no son lo mismo

Es la distinción que gobierna todo el diseño.

| | **Actualización** | **Emergencia** |
|---|---|---|
| Quién la activa | nosotros, siempre | el equipo, solo |
| Base | `/ota/new/` (o una URL manual) | `/ota/emergency/`, `emergency.bin` |
| Archivo | `<version>.bin`, del manifiesto | nombre FIJO |
| Para qué | desplegar una versión | recuperarse de una rota |
| Qué versión va ahí | la última | el **último bueno conocido** |

**La de emergencia no es "la última".** El equipo la baja sin que nadie se lo
pida, cuando se detecta roto. Si ahí está la misma versión de la que está
tratando de escapar, el mecanismo deja de existir. Por eso son dos acciones
distintas en la pantalla, con confirmaciones distintas, y hay un aviso cuando las
dos ranuras apuntan al mismo release.

### Condiciones de activación

**Actualización** — tienen que dar todas:
1. no hay otro OTA en curso;
2. **energía en modo `ACTIVE_*`** (si no: `ack error`, no queda esperando);
3. si es URL manual, pasa la allowlist;
4. internet en ≤10 min;
5. manifiesto válido (formato, `hw_model`, versión, tamaño, sha);
6. menos de 3 intentos fallidos **para ese target** (un target nuevo resetea el
   contador — si no, un deploy malo bloquearía también a la versión que lo
   arregla).

**Emergencia** — la levanta un trigger interno que **hoy está en `if (0)`**
(`task_admin.c`). Si se levantara: cooldown de 1 día → gate de energía → bandera
NVS → reboot a `emergency_mode`, que arranca solo WiFi + OTA y a los 30 min
vuelve a operación normal si no lo logró. Ver `docs/propuestas-firmware-ota.md`
§F-OTA-3.

## 2. El host es el APEX, y no es negociable

`ota_url_is_allowed()` compara contra `OTA_ALLOWED_HOST` = `cpssecurity.com.ar`,
**host exacto**:

```
https://cpssecurity.com.ar/firmware/…         ✓
https://system.cpssecurity.com.ar/firmware/…  ✗ rechaza sin bajar nada
```

Los dos nombres resuelven a la misma Raspberry, así que es cuestión de servir la
carpeta desde el server block correcto — el del sitio institucional, que no vive
en este repo.

## 3. Cómo queda en el disco

```
FIRMWARE_ROOT/alarmavecinal/ota/
├── new_0_6_0/          ← una carpeta por versión
│   ├── manifest.json
│   └── new_0_6_0.bin
├── new/                ← ranura: COPIA de la publicada
│   ├── manifest.json
│   └── new_0_6_0.bin
└── emergency/          ← ranura: COPIA, renombrada
    ├── manifest.json
    └── emergency.bin
```

Copia y no symlink: el equipo arma la URL como base + archivo, así que el `.bin`
tiene que estar físicamente al lado de su `manifest.json`. 1,2 MB duplicados no
son nada y se razona mejor cuando algo falla.

La carpeta lleva la **versión completa** (`new_0_6_0/`) y no el número pelado
(`0_6_0/`, como sugiere la nota de convención del firmware): con el número
pelado, `new_0_6_0` y `stable_0_6_0` colisionan.

## 4. Qué se lee del `.bin` y qué se tipea

Del archivo salen `project_name`, `size_bytes` y `sha256`. **La versión se
tipea**, y no por comodidad: el `CMakeLists.txt` del firmware no define
`PROJECT_VER`, así que la imagen declara su `git describe` (`f1a0459-dirty`).
Propuesta para arreglarlo: `docs/propuestas-firmware-ota.md` §F-OTA-1.

Lo que sí ataja la web: rechaza un binario que no es una imagen ESP32, uno sin
descriptor de aplicación (el `bootloader.bin`), uno que no entra en el slot, y
**el mismo binario subido dos veces con nombres distintos** (compara sha256).

## 5. Mandar la actualización

`/actualizaciones/equipos` lista la flota comparando `device_state.fw` contra la
versión publicada en `new`, y clasifica en **al día / desactualizado / sin
datos**. "Sin datos" no es "desactualizado": `fw` llega por el `status` retained,
así que un equipo que nunca conectó no tiene ninguno.

Se tildan equipos y se manda. **Esto no es una campaña**: cada equipo recibe su
propio comando con su propio `cid`, por la misma puerta
(`DeviceCommandsService.mandar`) que desde su ficha, con la misma validación de
alcance y el mismo `audit_log`. No hay broadcast — el firmware lo prohíbe,
porque el equipo no compara versiones y una oferta repetida es un reboot real.

El resultado se informa **equipo por equipo**. Va a haber rebotes y no por error:
de noche un poste solar no está en modo activo y rechaza el OTA.

Se manda `fuente: "auto"` y no la URL de la versión: así el equipo baja lo que
esté publicado en `/new/` cuando despierte, y republicar la ranura no deja
comandos viejos apuntando a una versión que ya no queremos.

### Hasta dónde se puede afirmar que una actualización funcionó

**Esto es lo más importante de esta página, y es menos de lo que parece.**

La versión que reporta un equipo (`device_state.fw`) **no es evidencia
independiente: es una etiqueta nuestra que él nos devuelve.** La cadena:

1. `task_ota` escribe en NVS `target = m.version` —el string que pusimos en
   nuestro manifiesto— **antes de empezar a descargar**.
2. Al reiniciar, el self-test comprueba **una sola cosa**:
   `system_state_internet_ok()`. Si hay internet en 10 minutos, marca la imagen
   válida, cancela el rollback y hace `installed = target`.
3. Eso es lo que reporta como su versión.

O sea que ver la versión nueva prueba que **una imagen arrancó y consiguió
internet**. No prueba que el firmware ande: la alarma puede estar muda, el RF
sordo o el bus I2C caído, y el equipo va a reportar la versión nueva igual.

> Ese hueco —"bootea pero anda mal"— es exactamente para el que se diseñó
> `emergency_mode`, y su trigger sigue en `if (0)` (F-OTA-3).

Por eso la pantalla dice **"arrancó con la nueva"** y no "actualizada", y
distingue cinco situaciones en vez de un tilde verde:

| | Qué se puede afirmar |
|---|---|
| **arrancó con la nueva** | volvió a hablar DESPUÉS del reinicio y cambió de versión |
| **instalada, reiniciando** | instaló, pero todavía no lo escuchamos: no se sabe nada |
| **no aplicó** | volvió con la versión anterior → revirtió |
| **sin confirmar** | no hay con qué comparar (p. ej. no sabemos qué tenía antes) |
| **falló** | el propio equipo reportó el rechazo |

Las dos condiciones de "arrancó" son las dos necesarias. Comparar solo
`fw == publicada` daba un **falso positivo** —lo mostró en producción el
2026-08-06— porque no distinguía una lectura vieja, anterior al reinicio, de una
posterior.

### Qué se ve mientras actualiza, y dónde termina

El equipo va contando por `up t:ota`: recibió el pedido → bajando el manifiesto
→ descargando → verificando → **instalada, reiniciando**. Ahí se corta, y no es
una falla: publica ese último mensaje y **medio segundo después se reinicia
solo** (`esp_restart()` en `task_ota.c`). El reinicio es automático; no espera
ninguna orden.

Lo que viene después —el self-test que confirma la imagen o la deja revertir— el
firmware **no lo publica** (`ota_report` emite 8 de los 11 estados; `self_test`,
`confirmed` y `rolled_back` no los emite nadie). O sea:

| Lo que pasa | Cómo se ve |
|---|---|
| Actualizó bien | el equipo empieza a reportar la versión nueva → **"actualizada"** |
| Revirtió (no arrancaba bien) | sigue reportando la vieja → queda **desactualizado** |

Por eso la pantalla combina las dos señales: el estado `instalada, reiniciando`
más la versión que el equipo reporta. **Un rollback no llega como error**, se
deduce. Cerrarlo de verdad es F-OTA-5 en `docs/propuestas-firmware-ota.md`: dos
líneas en el self-test.

## 6. Lo que falta hacer en el servidor (necesita sudo)

`deploy/apex-firmware.conf` tiene el bloque listo para pegar en el server block
443 del sitio institucional, más las instrucciones. Hasta que eso esté:

```
curl -I https://cpssecurity.com.ar/firmware/alarmavecinal/ota/new/manifest.json
```

devuelve el 404 del sitio institucional (con `Content-Type: text/html`), y el
equipo bajaría una página web creyendo que es un manifiesto.

El otro lado —que la carpeta exista y el backend pueda escribirla— lo revisa el
botón **"Verificar el servidor"** de la pantalla de versiones.

## 7. Lo que queda pendiente

**Actualizaciones pendientes** (decidido el 2026-08-06, sin implementar). Hoy un
OTA a un equipo fuera de modo activo **se pierde**: el firmware contesta error y
se termina ahí. En una flota solar eso significa que actualizar de noche no
actualiza nada, y que hay que acordarse de volver a mandarlo.

La idea es una cola nuestra: el pedido queda anotado y se reintenta cuando el
equipo reporta modo activo. No es lo mismo que una campaña —sigue siendo una
persona la que decide qué equipos— pero saca de encima el "acordate de
reintentar".

Ojo con dos cosas cuando se retome: el `cmd t:ota` **no tiene expiración**
(§F-OTA-4 de las propuestas), y el equipo no compara versiones, así que un
reintento tiene que verificar que siga haciendo falta antes de mandarse.

## 8. Dónde está cada cosa

| | |
|---|---|
| Catálogo y publicación | `backend-nestjs/src/firmware/` |
| Reglas del manifiesto y las rutas | `firmware-catalog.ts` |
| Lectura del `.bin` | `esp-image.ts` |
| Traducción de los enums del panel | `ota-estados.ts` |
| Las dos pantallas | `frontend-angular/src/app/features/firmware/` |
| Migraciones | `FirmwareCatalog`, `OtaProgress` |
| nginx del apex | `deploy/apex-firmware.conf` |
| Lo que le pedimos al firmware | `docs/propuestas-firmware-ota.md` |
