---
name: dominio-check
description: Use when modeling, renaming, or adding anything about alarms, neighborhoods, homes, remote controls, accounts, contracts, plans, quotas, or device state in the CPS Security project — before writing the migration, entity, endpoint, or UI screen.
---

# Chequeo contra las reglas del dominio (CPS Security)

## Para qué

Las 5 reglas de `CLAUDE.md` son **no negociables**. Casi todos los errores de
modelado del proyecto son una de estas cinco violadas, y salen baratas si se
detectan antes del SQL: después ya hay migración, entidad, DTO y pantalla.

Corré esto **antes** de escribir el código, no después.

## Las 5 preguntas

### 1. ¿A quién le colgás la alarma?

La alarma es del **BARRIO** (infraestructura pública). Nunca de la vivienda.

- ❌ `home.alarm_id`, `alarm.home_id`, "las alarmas de mi casa"
- ✅ `alarm.neighborhood_id`; el hogar a lo sumo tiene una alarma **preferida**

Aplica igual a la UI: una pantalla "Mis alarmas" dentro del hogar ya está mal
encuadrada aunque el SQL esté bien.

### 2. ¿De quién es el control remoto?

El control es del **HOGAR**. El portador es un dato **aparte y reasignable**.

- ❌ `remote_control.user_id` como dueño
- ✅ control → hogar; portador → asignación con historia (`user_device`)

Pregunta de control: si el vecino se muda o le presta el control a un hijo,
¿el modelo lo soporta sin borrar nada?

### 3. ¿Estás mezclando ESCALA con QUIÉN OPERA?

Son **dos ejes independientes**. Nunca derivar uno del otro.

| Eje | Campo | Qué dice |
|---|---|---|
| Escala | `account.subtype` | MUNICIPAL = varios barrios / COMMUNITY = uno |
| Operación | `neighborhood.managed_by` | ORGANIZATION o CPS, **barrio por barrio** |

- ❌ "si es COMMUNITY entonces lo opera CPS"
- ✅ una cuenta MUNICIPAL puede tener un barrio operado por CPS y otro por ella

Además: **todo cliente es una ORGANIZATION** con un **OWNER institucional** (no
una persona — el personal rota). No existen cuentas HOME ni contratos por
vivienda; los vecinos entran por `home_member`.

### 4. ¿Quién toca los cupos?

Los cupos son **tarifa**, y **solo CPS los modifica**, siempre con `audit_log`.

`max_neighborhoods`, `max_admin_users`, `max_technician_users`,
`max_monitor_users`, `max_family_members`, `remote_controls_enabled`.

- **0 = ese rol no existe en la cuenta** (no es "sin límite")
- Se imponen al crear; reducirlos aplica **grandfathering**
- `plan` es una **plantilla que se copia al vender**, nunca se lee en vivo
- **Los eventos son ilimitados** — no inventes un cupo de eventos

- ❌ un endpoint que deja al ADMIN de la organización subirse un cupo
- ❌ leer `plan.max_*` en runtime para decidir si algo entra
- ✅ leer los `max_*` **de la cuenta**; escribirlos solo desde CPS + auditoría

### 5. ¿Dónde va ese dato: Postgres o `device_state`?

Postgres guarda **qué ES** y **qué PASÓ**. El **estado vivo** va en
`device_state`, y lo escribe **únicamente el servicio de alarmas**.

- ❌ que la web escriba `device_state` (los GRANTs lo impiden, pero igual)
- ❌ una columna `alarm.esta_sonando` o `device.online` en la tabla del equipo
- ✅ un solo escritor por tabla; la web lee `device_state`, no lo actualiza

Recordá que el servicio de alarmas es **otro programa** (repo
`gateway-to-device`) que comparte SOLO la base. No lo diseñes desde acá.

## Qué hacer si algo no encaja

Ninguna de las 5 se negocia sobre la marcha. Si el requerimiento parece
pedir violarlas, **casi siempre el requerimiento está mal encuadrado**:
replantealo en los términos correctos y proponéselo al usuario antes de codear.

Si de verdad hay que cambiar una regla, es una decisión de negocio: se discute,
se decide, y se escribe en `docs/negocio-redisenado.md` y en
`frontend-angular/docs/pendientes-y-decisiones.md`. No se cambia en el código.

## Referencias

- `CLAUDE.md` — las 5 reglas, forma corta
- `docs/negocio-redisenado.md` — cómo funciona el negocio
- `docs/diseno-relaciones-fase1.md` — por qué el modelo es así
- `docs/esquema-postgres-v2.sql` — el DDL, fuente de verdad
