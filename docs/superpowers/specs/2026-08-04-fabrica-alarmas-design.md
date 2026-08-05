# Fábrica de alarmas — alta atómica, credenciales y etiqueta (2026-08-04)

> Un botón **Fabricar** que no vuelve hasta que el equipo existe, está registrado en
> el broker y tiene sus credenciales del portal derivadas. Si algo de eso falla, no
> queda ningún equipo a medio hacer. Después se imprime una etiqueta y listo.

Hermano de [`2026-08-04-provisioner-broker-design.md`](2026-08-04-provisioner-broker-design.md),
que definió la cola y el proceso privilegiado. Este spec lo extiende.

---

## 1. Alcance

**Adentro**: el alta de fábrica, las credenciales (MQTT + portal local), la etiqueta
imprimible y la escalera de etapas.

**Afuera, con spec propio**: la configuración del equipo, la reforma de la pestaña de
alarmas, la entrega a una organización y el claim de instalación.

## 2. El problema

Hoy el alta encola la credencial MQTT y sigue de largo: el equipo queda creado aunque
el broker nunca se entere. Y las credenciales del **portal local** del equipo —usuarios
`admin` y `cps`, que el firmware ya deriva y espera— no existen en ningún lado de la
web. Sin ellas no hay etiqueta, y sin etiqueta el técnico no puede entrar al equipo.

## 3. Quién tiene qué

La regla que no se negocia: **la web nunca ve un salt**. Son secretos maestros de toda
la flota y el proceso web es el único expuesto a internet.

| | Secretos | Responsabilidad |
|---|---|---|
| **Web (NestJS)** | `CPS_CRED_KEY` | valida la MAC, resuelve el modelo de placa, genera el claim code, encola, espera, descifra para mostrar |
| **Provisioner (Raspberry)** | `SALT_MQTT`, `SALT_TEC`, `SALT_CPS`, `CPS_CRED_KEY` | registra en Mosquitto, deriva las del portal, cifra y confirma |

Los tres salts ya existen y son los de producción: viven en
`AlarmaESP32V6/components/wifi_manager/wifi_secrets.local.h`, que está gitignoreado y
sin trackear. **Se verificó que `SALT_MQTT` reproduce el vector de verificación**
`A842E38FCA6C → 4EA453D76DD9E1C81A0D141B`, así que el archivo es el bueno. Al
provisioner llegan por variable de entorno, nunca por archivo del repo.

### 3.1 El cifrado

El provisioner cifra con **AES-256-GCM** antes de escribir en `device`. La clave
`CPS_CRED_KEY` es simétrica y la comparten provisioner y web; el formato guardado es
`base64(nonce ‖ ciphertext ‖ tag)`.

Cifrar del lado del provisioner y no de la web tiene una razón concreta: si las
passwords viajaran en claro por la cola, quedarían en claro en la tabla y en el WAL de
Postgres hasta que alguien las borrara. Así nunca existen en claro fuera de memoria.

> **Consecuencia aceptada** (decisión del usuario, 2026-08-04): guardar las passwords
> significa que un compromiso de *backend + base* expone el portal de todos los equipos
> registrados. Es menos que tener los salts —con esos se derivan también los equipos
> que todavía no existen— pero no es gratis. Se eligió por comodidad operativa:
> reimprimir una etiqueta no depende de que el provisioner esté vivo.

## 4. Las credenciales del portal

Definidas por el firmware en
[`docs/provisioning_credenciales_ap_portal.md`](../../../../AlarmaESP32V6_05-03-2026/docs/provisioning_credenciales_ap_portal.md).
El provisioner las implementa **sin reinterpretar nada**:

```
ssid_ap    = "AlarmaVecinal-" + MAC STA hex mayúsculas
qr_wifi    = "WIFI:S:<ssid_ap>;T:nopass;;"          (AP abierto: T:nopass, sin P:)
MAC SoftAP = MAC STA + 1        (aritmética sobre los 48 bits, no sobre el último octeto)
pass(rol)  = djb2_xor(salt_del_rol, MAC SoftAP) & 0xFFFFFF  → 6 hex mayúsculas
```

`admin` usa `SALT_TEC`; `cps` usa `SALT_CPS`. El djb2 va acotado a 32 bits en cada
paso — sin ese mask, Python y JS dan otra cosa.

### 4.1 El `+1` de la SoftAP no está verificado en hardware

Es el riesgo operativo más concreto de todo este spec. Con los salts reales, para la
placa `A842E38FCA6C`:

| origen de la MAC | `admin` |
|---|---|
| SoftAP (`…CA6D`) — lo que dice el doc | `2B0C49` |
| STA (`…CA6C`) — si el doc estuviera mal | `2B0C48` |

**Difieren en un solo carácter.** El djb2 XOREA el último byte al final, así que un `+1`
mueve un bit y nada más. Si el `+1` está mal, la etiqueta sale con una clave que parece
correcta, no abre nada, y nadie lo detecta mirándola.

**Antes de imprimir una tanda** hay que entrar al portal de la placa real con `2B0C49`.
Es acción humana, dos minutos, y no la reemplaza ningún test.

## 5. El alta atómica

Decisión del usuario (2026-08-04): **todo o nada, incluida la credencial MQTT**. Si el
provisioner no está, no se fabrica.

No puede ser una transacción de base: el provisioner no ve la fila encolada hasta el
COMMIT, así que esperar adentro de la transacción es esperar para siempre. Es una
**compensación**:

1. **TX1** — valida la MAC, resuelve la placa, crea el `device` en `INVENTORY` con su
   claim code y encola `manufacture`. COMMIT.
2. La web **sondea la fila cada 250 ms** hasta que se cierra, con timeout de **30 s**
   (`PROVISIONING_TIMEOUT_MS`). Se evaluó un `LISTEN` sobre un canal de vuelta y se
   descartó: ahorra milisegundos a cambio de una conexión dedicada viva para siempre,
   las altas son de a una y a ritmo humano, y sondear no puede perderse un evento —
   que es exactamente el bug que costó el barrido de pendientes (P0-1).
3. **`done`** → 201 con serial, placa, claim code, SSID, QR y las dos credenciales.
4. **`failed` o timeout** → `audit_log` con la MAC, el motivo y el actor, y se **borra
   el `device`**. La respuesta explica qué falló; el formulario del front conserva lo
   tipeado para reintentar.

El `audit_log` es a propósito lo único que sobrevive: la fila de la cola se va por
`ON DELETE CASCADE` junto con el equipo, y un intento fallido sin rastro es un intento
que se repite a ciegas.

### 5.1 Credenciales huérfanas

Si el broker alcanzó a registrar y la operación falló después, borrar el `device` deja
un usuario en `gtd.passwd` sin equipo que lo use. Se resuelve con un **barrido de
huérfanos** en el arranque del provisioner: compara `gtd.passwd` contra `device.serial`
y revoca lo que sobra. Es la misma disciplina del barrido de la cola (P0-1) — un
`NOTIFY` perdido y una credencial huérfana son el mismo tipo de bug.

### 5.2 Desarrollo

El provisioner ya trae `ColaFalsa` y `RegistradorFalso`. En la máquina de desarrollo se
corre `python -m gtd.provisioner` contra el Postgres local con salts de desarrollo y el
registrador falso: se fabrica normal, sin Mosquitto y sin tocar `/etc/mosquitto`.

### 5.3 El reload por equipo

Esperar el alta en el broker implica un `systemctl reload mosquitto` por equipo, que es
justo lo que el flag `--no-reload` vino a evitar. Se acepta porque el caso que lo hacía
grave —**alta masiva por CSV**— está fuera de alcance (§10 del spec del provisioner).
Cargando placa por placa a ritmo humano, ~1 s por equipo no molesta. Si algún día
aparece el import masivo, va a necesitar su propio camino de todas formas.

## 6. Base de datos

Una migración, a mano como todas (ver `backend-nestjs/docs/migraciones.md`):

```sql
ALTER TABLE device
  ADD COLUMN portal_admin_enc  TEXT,        -- base64(nonce‖ct‖tag), AES-256-GCM
  ADD COLUMN portal_cps_enc    TEXT,
  ADD COLUMN portal_derived_at TIMESTAMPTZ;

ALTER TABLE device ADD CONSTRAINT chk_device_portal_creds CHECK (
  (portal_derived_at IS NULL AND portal_admin_enc IS NULL AND portal_cps_enc IS NULL)
  OR (portal_derived_at IS NOT NULL AND portal_admin_enc IS NOT NULL AND portal_cps_enc IS NOT NULL)
);
```

Más: `gtd.provisioning_queue.op` acepta `'manufacture'`, y una función nueva

```sql
gtd.confirm_manufacture(p_id BIGINT, p_res TEXT, p_admin_enc TEXT,
                        p_cps_enc TEXT, p_det TEXT DEFAULT NULL) RETURNS TEXT
```

`SECURITY DEFINER`, con `EXECUTE` **solo** para `cps_provisioner`. Con `'ok'` escribe
`mqtt_provisioned_at`, las dos columnas cifradas y `portal_derived_at`; con cualquier
otra cosa marca `failed` con el detalle y **no toca** `device`. Siempre deja `audit_log`.

`DeviceStage` no se toca en la base porque nunca fue una columna: se deriva
(`device-view.ts`). Pasar de cuatro peldaños a tres es solo TypeScript.

## 7. Las etapas

`CREATED → PROVISIONED → LABELED → CONNECTED` pasa a
**`FABRICADO → ETIQUETADO → CONECTADO`**.

Con el alta atómica, `mqtt_provisioned_at` se escribe en el mismo instante en que nace
el equipo: `CREATED` no puede existir ni un segundo, y mantenerlo solo serviría para que
un equipo revocado aparezca como "creado", que es lo contrario de lo que pasó.

El estado de la credencial MQTT (registrada / revocada / falló) se muestra aparte, no
como etapa. Y sigue en pie el aviso del spec anterior: un equipo en `RETIRED` con
`mqtt_provisioned_at` cargado se marca en la ficha.

## 8. La pantalla de fábrica

**Formulario**: MAC · **modelo de placa (select del catálogo)** · **número** · probado.
Hoy es un solo campo tipeado (`ALOY0043`) y el prefijo se presta a error de tipeo; el
catálogo `board_model` ya existe y da la lista.

**Botón `Fabricar`** — bloquea mientras espera al provisioner, con el estado a la vista
("registrando en el broker…"). No es un spinner mudo: la espera puede ser de segundos.

**Tarjeta de resultado**: serial, placa, SSID, `admin` + clave, código de reclamo, y
`cps` + clave **detrás de un botón "ver" que deja `audit_log`**. El firmware es explícito
en que `pass_cps` jamás se imprime; mostrarla siempre en una pantalla de fábrica es cómo
termina en una captura.

**Botón `Imprimir etiqueta`** — sella `labeled_at` si estaba vacío. Reimprimir no lo
cambia: la primera impresión es la que cuenta. Se mantiene un desmarcado manual para la
etiqueta que se arruinó.

**Tabla**: etapa, custodia (fábrica / entregado / instalado) y estado de la credencial
MQTT. Se corrige de paso que `provisioning.queue` venga en los listados — hoy solo lo
llena `findOne`, así que en la tabla un equipo "en cola" se ve idéntico a uno que nunca
se pidió.

## 9. La etiqueta

**90 × 45 mm, blanco y negro** (variante G1). Se imprime desde el front con
`window.print()` y `@page`, sin servicio de impresión.

```
┌──────────────────────────────────────────────────┐
│ CPS SECURITY                          ALOY0043   │
│ AV-A842E38FCA6C                                  │
├──────────────────────┬───────────────────────────┤
│  CONEXIÓN WIFI LOCAL │      ALTA DEL EQUIPO      │
│ AlarmaVecinal-A842…  │                           │
│ ┌────┐ CREDENCIALES  │  CÓDIGO DE RECLAMO  ┌────┐│
│ │ QR │ PORTAL        │  K7M2QX             │ QR ││
│ │    │ 192.168.4.1   │                     │    ││
│ └────┘ Usuario admin │                     └────┘│
│  WiFi  Clave  7F3A21 │                      APP  │
└──────────────────────┴───────────────────────────┘
```

- Los dos QR **del mismo tamaño (16 mm)**, en bordes opuestos y rotulados. Pegados se
  pisan: la cámara agarra el que quiere.
- Izquierda, **QR WiFi**: `WIFI:S:<ssid>;T:nopass;;`. Lo lee la cámara nativa.
- Derecha, **QR de la app**: texto plano con marca de versión —
  **`CPS1|AV-A842E38FCA6C|K7M2QX`**. Los cinco caracteres del prefijo permiten cambiar el
  formato después sin que la app adivine; en etiquetas que se pegan a un poste y no
  vuelven, eso vale. Solo sirve escaneado desde adentro de la app, que todavía no existe.
- El SSID escrito completo en un renglón, para poder tipear la red si el QR no lee.
- **`pass_cps` no aparece.** Nunca.

## 10. Permisos

- **Fabricar**: solo CPS (ya es así).
- **Ver `pass_admin`**: cualquier usuario de CPS que pueda ver el equipo — va impresa en
  la etiqueta igual.
- **Ver `pass_cps`**: permiso aparte, y cada lectura deja `audit_log` con quién y cuándo.
- Todo endpoint con `:id` valida alcance además de rol
  (`backend-nestjs/docs/seguridad.md`).

## 11. Qué se prueba

**Derivación** (provisioner): el vector `A842E38FCA6C → 2B0C49 / 901D80` como KAT; el
djb2 acotado a 32 bits; el `+1` con carry cuando el último byte es `FF`; la MAC aceptada
con `:`, sin separadores y como `AV-…`.

**Cifrado**: ida y vuelta con `CPS_CRED_KEY`; un ciphertext alterado falla la
autenticación de GCM en vez de devolver basura.

**SQL, con los roles de verdad**: `confirm_manufacture('ok')` escribe las tres columnas;
con error deja `failed` sin tocar `device`; `cps_provisioner` no puede encolar; `cps_web`
no puede confirmar.

**Backend**: el alta espera y devuelve todo; un `failed` borra el equipo y deja
`audit_log`; un timeout hace lo mismo; ver `pass_cps` sin el permiso da 403 y con el
permiso deja `audit_log`.

**Front**: imprimir sella `labeled_at` una sola vez; el select de modelo arma el número
de placa; el error de fabricación conserva el formulario.

## 12. Fuera de alcance

- Alta masiva por CSV (§5.3).
- Rotación de salts. Si rota alguno, cambian las passwords de toda la flota y hay que
  reflashear y reimprimir: es un procedimiento, no una función.
- La app del técnico. El QR se imprime hoy y sirve cuando exista.
- El despliegue. Sigue valiendo lo del spec anterior: la base de producción se va a
  llamar `cpssecurityarg` y el primer paso es correr las migraciones contra un
  Postgres 17 real.
