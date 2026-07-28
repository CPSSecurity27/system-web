# CPS Security — El negocio rediseñado

> **Fecha:** 2026-07-16 · **Estado:** VIGENTE — diseño cerrado e implementado en el
> backend (modelo v2). Este informe describe **cómo funciona el negocio**, en lenguaje
> de negocio. El detalle técnico está en `diseno-relaciones-fase1.md` y
> `esquema-postgres-v2.sql`; el estado del proyecto, en `estado-proyecto.md`.

---

## 1. Qué vende CPS (en un párrafo)

CPS Security vende **seguridad comunitaria monitoreada**: alarmas instaladas en la vía
pública de un barrio (postes, sirenas — infraestructura compartida, nunca del vecino
individual), controles remotos para que cada hogar las dispare, una app para los
vecinos, y un panel de administración y monitoreo. El servicio se cobra por **contrato
con cupos flexibles**: el cliente paga por cuántos barrios, cuántos monitores y cuántos
familiares por hogar puede tener — y ampliar cualquier cupo es una llamada a CPS y un
ajuste de tarifa.

## 2. Las dos líneas de negocio

El sistema es uno solo; lo que cambia es **quién opera** después de la venta.

### 2.1 PÚBLICO — venta a municipalidades (autogestión total)

CPS le vende el sistema a una municipalidad y **le entrega las llaves**:

1. CPS crea la cuenta de la organización ("Municipalidad de San Pedro"), su usuario
   institucional OWNER (`muni_sanpedro`) y el contrato con sus cupos.
2. **Acto de entrega:** las credenciales del OWNER pasan a la municipalidad (queda
   auditado). Desde ese momento la cuenta es de ellos.
3. La municipalidad se autogestiona por completo: con el OWNER crea sus administradores
   (personas reales), y ellos crean barrios, hogares, vecinos, técnicos y monitores —
   **hasta los cupos que compró**. Sin pedirle nada a CPS.
4. CPS conserva para sí: el stock y provisioning de equipos, la configuración avanzada
   de las alarmas, la modificación de cupos y las transferencias de comunidades.

**El negocio del cupo:** la muni crea barrios libremente hasta `max_neighborhoods`.
¿Quiere el barrio 11 y compró 10? Llama a CPS, se ajusta la tarifa, CPS sube el cupo, y
la muni sigue sola. Lo mismo con monitores y familiares por hogar. La autonomía del
cliente y el modelo de ingresos de CPS quedan alineados sin fricción.

### 2.2 PRIVADO — venta a comunidades / barrios (CPS opera todo)

CPS le vende el servicio a una comunidad (consorcio, junta vecinal, grupo de vecinos):

1. CPS crea la cuenta de la organización ("Consorcio Barrio Los Lapachos"), su OWNER
   institucional y el contrato del barrio.
2. Las credenciales del OWNER se entregan al representante de la comunidad **o quedan
   en custodia de CPS** si el grupo no tiene estructura formal. La cuenta existe igual:
   es la contraparte del contrato.
3. **CPS gestiona todo**: el barrio, los hogares, los vecinos, los equipos, los
   controles. La comunidad recibe el servicio.
4. Opcional de venta: si la comunidad tiene un guardia o encargado, se le crea un
   usuario MONITOR limitado a su barrio (dentro del cupo `max_monitor_users`) para que
   vea el estado de las alarmas y atienda eventos.

### 2.3 El puente entre las dos líneas

Como ambos esquemas usan el mismo molde (cuenta + OWNER + contrato + barrio), los dos
movimientos comerciales futuros son triviales:

- **Comunidad privada pasa a un municipio** (el caso clásico): se transfiere el barrio a
  la cuenta de la muni. Hogares, vecinos, equipos, controles e historial quedan intactos.
- **Un consorcio crece y quiere autogestionarse**: se le cambia la modalidad de gestión
  y se le entregan las credenciales de su OWNER. Nada se migra.

Solo CPS puede ejecutar estos movimientos, y quedan auditados.

## 3. El modelo de tarifa: contrato + cupos

**El contrato** fija lo comercial y se congela al firmar (precio, fechas, estado), como
una factura: si mañana cambia la tarifa, los contratos viejos no cambian solos. Un solo
contrato activo por barrio; el historial de contratos vencidos se conserva.

**Los cupos** son la parte flexible de la tarifa — lo que el cliente compró en cantidad:

| Cupo | Qué limita | Nivel |
|---|---|---|
| `max_neighborhoods` | cuántos barrios puede crear la organización | organización |
| `max_monitor_users` | cuántos operadores de monitoreo puede tener | organización |
| `max_family_members` | cuántos familiares por hogar | barrio |
| `remote_controls_enabled` | si el barrio usa controles remotos | barrio |

Reglas de los cupos (uniformes, sin excepciones):

- **Solo CPS los modifica.** El cliente los ve, no los toca. Son la tarifa.
- **Se imponen al crear:** nunca se supera un cupo con un alta.
- **Reducir un cupo no destruye nada** (grandfathering): lo existente queda, las altas
  nuevas se bloquean hasta estar bajo el cupo. Nadie pierde el servicio por un cambio
  de tarifa.
- **Todo cambio de cupo queda auditado** (quién, cuándo, valor anterior → nuevo): esa es
  la trazabilidad tarifaria, sin re-firmar contratos.
- **Los eventos son ilimitados.** Un sistema de seguridad jamás rechaza una activación
  por tarifa.

## 4. Quién es quién

### 4.1 En el panel (web)

| Rol | Quién es | Qué hace |
|---|---|---|
| **OWNER** | **Usuario institucional** (`muni_sanpedro`, `consorcio_lapachos`, `cps_root`). Sin datos personales: la institución sobrevive a la rotación de empleados | Soberanía: crea/elimina ADMINs, políticas de seguridad, acepta transferencias. Se usa poco. 2FA obligatorio, email institucional, traspaso formal de credenciales en cada cambio de gestión, todo auditado. Exactamente uno por cuenta |
| **ADMIN** | Persona real (ej. ALE_COPA) | La operación diaria: barrios, hogares, vecinos, personal, dentro de su organización y sus cupos |
| **TECHNICIAN** | Persona real, técnico de campo | Instala y mantiene equipos: reclama dispositivos del stock, carga bitácora de mantenimiento. Acotable a barrios específicos |
| **MONITOR** | Persona real, operador de monitoreo | Ve estados y eventos, los atiende y resuelve. No crea usuarios ni toca configuración. Acotable a barrios específicos |

La misma persona puede tener varios sombreros (el técnico de CPS que además es vecino en
su casa): un solo usuario, varias membresías.

### 4.2 En la app de vecinos

| Rol | Quién es | Qué hace |
|---|---|---|
| **TITULAR** | El responsable del hogar (uno por hogar, un hogar por titular) | Dispara/gestiona desde la app, administra a sus familiares, ve los controles del hogar |
| **FAMILIAR** | Conviviente (hasta el cupo del barrio) | Usa la app y su control asignado |

Acceso de vecinos: **DNI + código por SMS/WhatsApp** (nunca DNI solo: es un dato
semi-público) y **un solo dispositivo activo por persona** — registrar un teléfono nuevo
desconecta el anterior. Los vecinos no pagan a CPS ni ven el panel: son beneficiarios.

## 5. La estructura del servicio

```
Organización (muni o consorcio)  ← la relación comercial y de soberanía
   └── Barrio                    ← la unidad operativa: acá vive el servicio
        ├── Alarmas comunitarias  (postes en la vía pública, del barrio)
        ├── Hogares               (dirección, GPS, teléfono de contacto,
        │    ├── Titular            alarma preferida para eventos individuales)
        │    ├── Familiares
        │    └── Controles remotos (del HOGAR, con o sin portador asignado)
        └── Personal asignado     (técnicos/monitores acotados por barrio)
```

Los dos principios que definen todo:

1. **La alarma es del barrio, no de la vivienda.** Infraestructura compartida. El hogar
   tiene controles que la disparan y, a lo sumo, una alarma *preferida*.
2. **El control es del hogar, no de la persona.** Quién lo lleva encima (titular,
   familiar, o nadie — "en el cajón") es un dato aparte y reasignable. Si un familiar
   se muda, el control queda en la casa.

## 6. El ciclo de los equipos (inventario y provisioning)

Cadena de custodia de tres niveles, igual para alarmas y controles:

```
FÁBRICA (stock CPS) ──venta──> STOCK DE ORGANIZACIÓN ──instalación──> EN SERVICIO
  serial + código de reclamo     (la muni compró un lote)              alarma → barrio
  probado sí/no                                                        control → hogar
```

- Cada equipo nace en CPS con **serial** y **código de reclamo** (claim code). El
  técnico —municipal o de CPS— instala el equipo y lo "reclama" con ese código: queda
  vinculado a su barrio. Así la muni se autogestiona la instalación **sin que CPS
  pierda el control del stock**: solo se puede reclamar lo que CPS fabricó y entregó.
- Cada alarma lleva su **bitácora de mantenimiento** (instalación, service, reparación,
  reemplazo) cargada por los técnicos.
- Cada control tiene **4 códigos RF** que se guardan **cifrados** (AES-256-GCM): ni un
  robo de la base de datos los expone. Verlos en claro es exclusivo de CPS y cada
  consulta queda registrada.
- La configuración avanzada de las alarmas (parámetros internos, credenciales de
  comunicación) es territorio exclusivo de CPS en ambos esquemas.

## 7. La operación en vivo: eventos y monitoreo

- Cuando una alarma se activa (desde la app, un control, o el equipo mismo) se genera
  un **evento**: qué alarma, qué hogar, quién lo disparó (con nombre y teléfono
  congelados al momento — si el vecino cambia de número, el evento histórico no miente),
  GPS, modo de disparo y alcance (individual o comunitario).
- Los **monitores** lo ven en su tablero en tiempo real, lo atienden y lo cierran como
  **resuelto** o **falsa alarma**. El historial completo queda para siempre: es la
  evidencia del servicio prestado y la métrica para renovar contratos.
- **Eventos ilimitados**: no hay cupo ni costo por activación.

### La arquitectura que lo hace confiable (decisión clave)

El sistema son **dos programas separados** que comparten únicamente la base de datos:

| Programa | Qué hace | Si se cae... |
|---|---|---|
| **Web** (panel + API + app) | administración, monitoreo, vecinos | las alarmas siguen sonando y registrando eventos |
| **Servicio de alarmas** (futuro, independiente) | habla con los equipos (MQTT), actualiza estado vivo, registra eventos, dispara notificaciones push | el panel sigue administrando; se recupera el vivo al volver |

Estanquidad total: ningún componente puede tirar abajo al otro. Firebase quedó eliminado
por completo del diseño.

## 8. Seguridad y confianza (argumentos de venta)

- **Aislamiento absoluto entre clientes:** cada organización ve solo lo suyo — filtrado
  en el servidor, no escondido en pantalla. Cruzar el límite da acceso denegado.
- **Auditoría de todo lo sensible:** cambios de cupo, transferencias, contratos, roles,
  suspensiones, reclamo de equipos, consultas de códigos RF, accesos del OWNER. Quién,
  cuándo, desde dónde, valor anterior y nuevo.
- **Credenciales institucionales con traspaso formal:** los cambios de gestión política
  no dejan cuentas huérfanas ni claves en manos del empleado que se fue.
- **Usuarios operativos siempre personales:** cada acción del día a día tiene nombre y
  apellido.
- **Suspensiones sin destrucción:** suspender un hogar, un barrio o un contrato apaga el
  servicio pero no borra nada; reactivar es instantáneo.
- **Datos de vecinos mínimos y protegidos:** DNI como identidad con verificación
  telefónica, códigos RF cifrados, teléfonos históricos congelados solo en eventos.

## 9. Las reglas de oro del negocio (resumen)

1. La alarma es del barrio; el control es del hogar; el portador es un dato reasignable.
2. Todo cliente es una organización con un OWNER institucional y un contrato por barrio.
3. Los máximos son tarifa: solo CPS los cambia, con auditoría y sin destruir lo existente.
4. Los eventos son ilimitados, siempre.
5. La muni se autogestiona hasta su cupo; el privado lo gestiona CPS. Mismo sistema.
6. Los equipos solo entran al servicio desde el stock de CPS, por reclamo con código.
7. Los vecinos no pagan, no ven el panel, y acceden con DNI + verificación, un
   dispositivo por persona.
8. Nada sensible ocurre sin dejar rastro.
9. La web y el servicio de alarmas viven separados: la caída de uno no voltea al otro.
10. No se toca código hasta que el diseño esté cerrado — y el diseño ya está cerrado.