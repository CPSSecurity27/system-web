# Propuestas para el firmware — OTA

> Este repo **NO edita el firmware**. Lo que sigue es lo que encontramos al
> construir el gestor de actualizaciones del lado de la web (2026-08-06), para
> que se decida allá. Cada punto dice qué pasa hoy, qué cuesta, y qué haríamos
> nosotros si no se toca.

## F-OTA-1 — `PROJECT_VER`: el binario no sabe qué versión es

**Qué pasa hoy.** `CMakeLists.txt` no define `PROJECT_VER`, así que ESP-IDF cae
al `git describe`. Verificado sobre el binario del taller:

```
project_name = "AlarmaESP32V6_05-03-2026"   ← confiable, sirve
version      = "f1a0459-dirty"              ← el git describe
```

Mientras tanto, la versión "de verdad" vive en un `#define FW_VERSION
"new_0_6_0"` de `system_config.h`, que **no viaja en la imagen**.

**Qué significa para nosotros.** Al subir un `.bin` al catálogo, la web puede
leer el proyecto, el tamaño y el sha256 del archivo, pero **la versión la tiene
que tipear una persona**. Es el único dato del manifiesto que depende de que
alguien no se equivoque, y equivocarse tiene consecuencia real: el equipo va a
reportar el nombre que le pusimos, corriendo un binario que puede ser otro.

**La propuesta.** Una línea:

```cmake
set(PROJECT_VER "${FW_VERSION}")   # o leerlo de un version.txt
project(AlarmaESP32V6_05-03-2026)
```

Con eso el `esp_app_desc_t.version` trae `new_0_6_0` y la web puede **exigir**
que coincida con lo tipeado, o directamente no preguntar.

**Si no se toca.** Queda como está: se tipea, se valida el formato, y la web
rechaza subir dos veces el mismo binario con nombres distintos (compara sha256).
Ataja el error más común, no todos.

---

## F-OTA-2 — `ota_design.md §0` está desactualizado y confunde

**Qué pasa hoy.** La tabla de estado del documento dice:

| Pieza | Dice el doc | Está en el código |
|---|---|---|
| Transporte MQTT de la oferta | **Pendiente** | Implementado (`task_mqtt.c:687`) |
| Handler de carga local en la UI | **Stub → 501** | Implementado (`ui_web.c:924`, con token) |

Y el encabezado de `task_ota.c` sigue diciendo *"nada de esto se dispara
todavía: sin MQTT no se llena `s_ota_request`"*, que ya no es cierto.

**Por qué importa.** Nos costó una lectura completa del código descubrir que el
OTA por MQTT **ya andaba**. Cualquiera que llegue después va a perder el mismo
tiempo, o peor: va a diseñar suponiendo que falta algo que está.

**La propuesta.** Actualizar §0 y el comentario de cabecera. Lo que sí sigue
dormido y conviene que quede marcado como tal es **el trigger de emergencia**
(§F-OTA-3).

---

## F-OTA-3 — El trigger de `emergency_mode` sigue en `if (0)`

**Qué pasa hoy.** Toda la cadena de emergencia está implementada y probada
—bandera NVS, gate de energía B1-EMG, cooldown de un día, rama de arranque,
descarga de `/ota/emergency/`— salvo la primera línea:

```c
/* task_admin.c */
if (0 /* TODO: condición de falla grave irrecuperable (supervisor) */) {
    s_emergency_requested = true;
}
```

**Qué significa.** La segunda capa de defensa **no existe en la práctica**. La
primera —el rollback nativo del bootloader— sí funciona y cubre "no bootea /
bootloop". Lo que queda descubierto es el caso para el que se diseñó la
emergencia: **"bootea, agarra internet, confirma el self-test, y anda mal"**. Un
firmware así el rollback lo da por bueno y se queda.

**Qué preparamos de nuestro lado igual.** La ranura `emergency` del catálogo ya
existe, se publica aparte de la automática, y la pantalla avisa cuando las dos
apuntan a la misma versión. El día que el trigger se defina, del lado del
servidor no hay nada que hacer.

**La pregunta que hay que contestar allá**, y que es de producto y no de código:
*¿qué cuenta como "estoy roto" para un panel que arranca bien?* Las constantes
previstas en el comentario (`OTA_BOOT_FAIL_THRESHOLD`,
`EMERGENCY_RELAUNCH_CYCLES`) sugieren "reinicios seguidos", pero eso ya lo cubre
el rollback. Los candidatos que se nos ocurren desde acá: watchdogs por hora
sobre un umbral, el bus I2C caído (sin reloj y sin EEPROM el panel no puede
registrar un disparo), o la task de alarma muerta.

---

## F-OTA-5 — El self-test confirma la imagen y no se lo cuenta a nadie

**Qué pasa hoy.** `ota_report()` emite **8 de los 11** estados de
`ota_state_t`. Los tres que faltan son justo los del final:

```
emite:      0 idle · 1 offer · 2 manifest · 3 rechazado ·
            4 bajando · 5 verificando · 6 listo para reiniciar · 10 falló

NO emite:   7 self_test · 8 confirmed · 9 rolled_back
```

El bloque que confirma la imagen (`task_admin.c`, tras un boot en
`PENDING_VERIFY`) hace `esp_ota_mark_app_valid_cancel_rollback()`, escribe la
versión en NVS, resetea el contador de intentos, loguea… y **no publica ningún
`up t:ota`**.

**Qué significa del lado del servidor.** El último mensaje que recibimos de una
actualización exitosa es `6` — "listo para reiniciar" —, publicado medio segundo
antes del `esp_restart()`. Después, silencio. Consecuencias:

- Una actualización que salió **perfecta** se ve igual que una que se colgó justo
  antes de reiniciar.
- Un **rollback es invisible**: el equipo simplemente vuelve reportando la
  versión vieja. No hay forma de distinguir "revirtió porque no arrancaba bien"
  de "el comando nunca llegó".
- Lo único que confirma el éxito es que `device_state.fw` cambie, y eso llega por
  el `status` retained, o sea con la demora de la reconexión.

**La propuesta.** Dos líneas en el self-test, en las dos ramas:

```c
if (s_pending_confirm) {
    if (system_state_internet_ok()) {
        esp_ota_mark_app_valid_cancel_rollback();
        …
        ota_report(OTA_ST_CONFIRMED, OTA_REJ_NONE);      /* ← nuevo */
    } else if (vencio) {
        ota_report(OTA_ST_ROLLED_BACK, OTA_REJ_NONE);    /* ← nuevo, antes del restart */
        esp_restart();
    }
}
```

El de `ROLLED_BACK` sale con la salvedad de que el `esp_restart()` es inmediato y
el mensaje puede no llegar a salir de la cola MQTT: convendría el mismo
`vTaskDelay(500)` que ya usa `task_ota` antes de reiniciar. Aun si se pierde a
veces, el de `CONFIRMED` solo ya cierra el caso normal.

**Mientras tanto, de nuestro lado.** La pantalla combina el estado `6` con la
versión que el equipo reporta: si ya coincide con la publicada, muestra
"actualizada"; si no, dice que reinició y que está por probarse. Y el sondeo se
corta a los 15 minutos, porque después de eso no va a llegar nada nuevo.

---

## F-OTA-6 — El self-test da por buena una imagen con solo tener internet

**Qué pasa hoy.** El bloque que decide si una imagen recién instalada se
confirma o se revierte comprueba exactamente una cosa:

```c
if (s_pending_confirm) {
    if (system_state_internet_ok()) {      /* ← esto es TODO el self-test */
        esp_ota_mark_app_valid_cancel_rollback();
        …
```

Con eso alcanza para cancelar el rollback para siempre. Una imagen que arranca,
levanta WiFi y no hace **nada más** —alarma muerta, RF sordo, I2C caído— pasa el
examen y se queda instalada.

**Por qué importa del lado del servidor.** Es el techo de lo que podemos
afirmar. La web puede decir "arrancó y consiguió internet" y nada más fuerte que
eso, porque no hay ninguna otra señal. Un panel puede quedar en la calle sin
poder sonar, reportando alegremente su versión nueva.

Y es el hueco exacto para el que existe `emergency_mode` (§F-OTA-3), cuyo trigger
sigue en `if (0)`: sin uno ni otro, "bootea pero anda mal" no lo detecta nadie.

**La propuesta.** Sumarle al self-test las comprobaciones que el equipo ya sabe
hacer y que no cuestan casi nada, antes de `mark_app_valid`:

- el bus I2C responde (sin reloj ni EEPROM el panel no puede registrar un
  disparo),
- las tasks críticas están vivas (alarma, RF),
- el supervisor contesta.

Cualquiera de esas que falle → no confirmar, dejar que el bootloader revierta.
Es la diferencia entre "arrancó" y "sirve", y es la única capa que puede tomar
esa decisión: el servidor no tiene con qué.

---

## F-OTA-4 — El `cmd t:ota` no tiene expiración

**Qué pasa hoy.** `mqtt_design.md` documenta 24 h de expiry para el `cmd t:ota`,
pero el GtD publica sin `properties` (`downlink.py`), así que no hay ninguna.

**Qué significa.** Un OTA mandado a un equipo dormido depende de la sesión
persistente del broker, no de una expiración nuestra. Si el equipo vuelve tres
días después, lo va a ejecutar igual — y para entonces la versión publicada puede
ser otra.

**No lo tocamos** porque es del GtD y porque hoy se compensa solo: mandamos
`fuente: "auto"`, así que el equipo baja **lo que esté publicado en `/new/` en
el momento de despertarse**, no lo que estaba publicado cuando se apretó el
botón. Queda anotado para cuando se haga el mecanismo de actualizaciones
pendientes, que es donde esto sí va a importar.
