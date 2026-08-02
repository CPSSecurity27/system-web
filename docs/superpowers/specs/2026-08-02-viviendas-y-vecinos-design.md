# Viviendas y vecinos — diseño completo (v2)

> **Fecha:** 2026-08-02
> **Estado:** aprobado, en implementación.
> **Alcance:** cargar viviendas con su titular y sus familiares desde el panel.
> El login y la activación del vecino **quedan afuera** (backend de app, sin definir).

---

## 1. El flujo, en una línea

Dar de alta una vivienda es **un solo acto atómico** que termina en una casa con
titular. No existe la vivienda sin dueño.

```
vivienda (dirección + barrio + GPS)
  + teléfono del hogar         ← opcional
  + alarma preferida           ← opcional, sugerida por cercanía
  + TITULAR (nombre + DNI)     ← obligatorio, en el mismo acto
```

Después, y por separado, se cargan los **familiares** contra el cupo del barrio.

---

## 2. De dónde salen estas decisiones

Se auditó la base Firebase real (`cpssecurityarg`, Realtime Database: 16
viviendas, 21 usuarios, 1 barrio). Los cruces de integridad dieron **limpios**
—ningún huérfano, ningún desync— pero eso es mérito del script semilla: el
modelo no tenía con qué impedirlo. Lo que se conserva y lo que no:

| Firebase | Problema | v2 |
|---|---|---|
| El mismo hecho en 3 lugares: `user.home_id`, `home.members{}`, `home.owner_id` | Nada obliga a que coincidan | Una fila en `home_member`. No hay copia que desincronizar |
| `remote.home_id` + `home.remotes{}` | Idem | `remote.home_id` y nada más |
| `login_index/app/{dni}` mantenido a mano | Índice que el código tiene que recordar | `UNIQUE` sobre `dni` |
| `stats: {owners, family}` a mano | Contadores que se desfasan al primer borrado | `COUNT(*)` |
| `role` mezcla `owner`/`family_member` con `admin_municipal` | Ser familiar de una casa y admin de un municipio son ejes distintos; en un campo son excluyentes | `account_user.role` (panel) vs `home_member.role` (hogar) |
| `credential_set: bool` | Copia de "tiene contraseña" que puede mentir | `password_hash IS NULL` |
| `community_id` en el user *y* en la home | Dos lugares que actualizar al mudar una casa | Solo `home.neighborhood_id` |

Y los datos dijeron tres cosas que se aplicaron tal cual:

- **1 de 16 viviendas tenía teléfono** → el teléfono del hogar es opcional.
- **16 de 16 tenían GPS** → el GPS es obligatorio y no molesta a nadie.
- **DNIs de 4 y 5 dígitos** (`25001`, `3535`) en 10 de 16 titulares → si el DNI
  es la identidad de login, hay que validarlo en serio (7 a 9 dígitos).

El usuario `guest` de Firebase (sin DNI, sin casa, sin barrio) **no se porta**:
en v2 no existe ese concepto.

---

## 3. Decisiones tomadas

| # | Decisión | Por qué |
|---|---|---|
| 1 | La **dirección identifica** la vivienda; `home.name` se elimina | Firebase nunca tuvo nombre y no le hizo falta. Con los dos campos, el gestor escribe la dirección en el nombre y quedan desincronizados |
| 2 | **GPS obligatorio** | Es dato operativo: el mapa del monitoreo y el `gps` del evento. 16 de 16 lo tenían |
| 3 | El **titular se carga en el mismo acto** que la vivienda | Una casa sin titular no sirve para nada y nadie vuelve al paso 2 |
| 4 | **DNI obligatorio**, email opcional | El DNI es la identidad de login del vecino (así era en Firebase). El email pasa a ser dato de contacto |
| 5 | **Una persona, una vivienda** | Sin esto, un vecino en dos barrios hace ambiguo qué barrio despertar y permite esquivar el cupo de familiares |
| 6 | Un solo campo `name` para el nombre completo | Firebase lo partía mal: `first_name: "Martín"`, `last_name: "Alejandro Ruiz Quintana"` |
| 7 | La **alarma preferida se sugiere por cercanía** | Con GPS obligatorio, el dato ya está. Hoy es un combo vacío que nadie completa |
| 8 | **`community_scope_enabled`** vuelve como permiso del barrio | Era `plan.community_mode_enabled` en Firebase. Habilita disparar todas las alarmas del barrio, y es una decisión comercial |
| 9 | **Sin parentesco** | `home_member.role` sigue siendo TITULAR/FAMILIAR y nada más |
| 10 | Teléfono y fecha de nacimiento **opcionales** | Datos de contacto, no identidad |

### Lo que NO se toca

- La alarma sigue siendo **del barrio**: `default_device_id` es preferencia, y el
  evento COMMUNITY cuelga de `neighborhood_id`, no del hogar (regla 1).
- Controles remotos: fuera de alcance.
- El login y la activación del vecino: backend de app.
- Los cupos los modifica **solo CPS**, con `audit_log` (regla 4).

---

## 4. El modelo

La relación vecino–vivienda **no vive en ninguna de las dos tablas**: es una fila
propia en `home_member`.

```
app_user                          home_member                  home
id  name              dni         home_id user_id role         id  address
─────────────────────────────     ────────────────────────     ──────────────────
18  Matías Parussini  25001       7       18      TITULAR      7   Mza A Casa 1
19  Rosa Cruz         49667788    7       19      FAMILIAR
20  Mariano Cruz      48556677    7       20      FAMILIAR
```

- *"¿Quiénes viven en la casa 7?"* → `WHERE home_id = 7`
- *"¿Dónde vive Rosa?"* → `WHERE user_id = 19`
- *"¿Quién es el titular?"* → la fila con `role = 'TITULAR'`. **No es una columna
  de `home`**; lo garantiza `uq_home_single_titular`.
- El `user.home_id` de Firebase se conserva como **índice**, no como columna:
  `uq_home_member_one_home` sobre `user_id`.

```
app_user ──┐
           ├── home_member (home_id, user_id, role)
home ──────┘
  │
  ├── neighborhood_id ──> neighborhood ──> device (N alarmas del barrio)
  └── default_device_id ─────────────────> device (1, la preferida)
```

### Los dos botones de la app

| En la app | `event.scope` | `device_id` | Requiere |
|---|---|---|---|
| "La alarma que responde por mi casa" | `SINGLE` | `home.default_device_id` | — |
| "Activar todo el barrio" | `COMMUNITY` | `NULL` | `neighborhood.community_scope_enabled` |

Con `COMMUNITY` va **un solo evento con `device_id` en NULL**, no uno por alarma:
es un hecho, no N. El tablero del monitoreo muestra una fila; el servicio de
alarmas lee el `neighborhood_id` y dispara todos los equipos del barrio.

> El texto de la UI dice "la alarma que responde por mi casa", nunca "mi alarma":
> la alarma es del barrio (regla 1) y el encuadre de la pantalla también cuenta.

---

## 5. Migración `HomeAddressAndNeighborResident`

```sql
-- La dirección identifica la vivienda; el GPS deja de ser opcional
UPDATE home SET address = name WHERE address IS NULL;
ALTER TABLE home DROP COLUMN name;
ALTER TABLE home ALTER COLUMN address   SET NOT NULL;
ALTER TABLE home ALTER COLUMN latitude  SET NOT NULL;
ALTER TABLE home ALTER COLUMN longitude SET NOT NULL;

-- Dato del vecino que faltaba
ALTER TABLE app_user ADD COLUMN birth_date DATE;

-- Una persona, una vivienda (reemplaza al índice parcial del titular)
DROP INDEX uq_user_single_titular;
ALTER TABLE home_member DROP CONSTRAINT uq_home_member;
DROP INDEX idx_home_member_user;
CREATE UNIQUE INDEX uq_home_member_one_home ON home_member(user_id);

-- Permiso comercial: disparar todo el barrio
ALTER TABLE neighborhood ADD COLUMN community_scope_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE plan         ADD COLUMN community_scope_enabled BOOLEAN NOT NULL DEFAULT true;
```

`uq_home_single_titular` se queda. `contact_phone` y `default_device_id` siguen
opcionales.

**`down()`**: revierte todo salvo el contenido de `home.name`, que no se puede
recuperar (se copia desde `address` al bajar, que es lo más honesto posible).

---

## 6. Datos

### Vivienda

| Campo | | Nota |
|---|---|---|
| `address` | **obligatorio** | identifica la vivienda |
| `neighborhoodId` | **obligatorio** | la comunidad a la que pertenece |
| `latitude` / `longitude` | **obligatorios** | click en el mapa |
| `contactPhone` | opcional | del hogar, sobrevive al titular |
| `defaultDeviceId` | opcional | sugerido por cercanía |

### Persona (titular y familiares, mismos campos)

| Campo | | Nota |
|---|---|---|
| `name` | **obligatorio** | nombre completo, un solo campo |
| `dni` | **obligatorio** | único global, 7–9 dígitos sin puntos. Es su login |
| `telephone` | opcional | viaja al evento como `activator_phone` |
| `birthDate` | opcional | columna nueva |
| `email` | opcional | dato de contacto |
| `passwordHash` | `NULL` al crear | la fija el vecino desde la app |

---

## 7. Endpoints

### `POST /homes` — transaccional

```jsonc
{
  "neighborhoodId": 3,
  "address": "Mza A Casa 5",
  "latitude": -24.23254, "longitude": -64.87439,
  "contactPhone": "+549388...",        // opcional
  "defaultDeviceId": 12,               // opcional
  "titular": {                         // OBLIGATORIO
    "name": "Martín Alejandro Ruiz Quintana",
    "dni": "77956729",
    "telephone": "+549...",            // opcional
    "birthDate": "1980-05-12",         // opcional
    "email": "..."                     // opcional
  }
}
```

Escribe `app_user` + `home` + `home_member(TITULAR)` **en una transacción**: si
algo falla no queda ni la casa ni el usuario a medias.

DNI repetido → **409 diciendo dónde está** ("ya es titular de Mza A Casa 7,
Barrio Santa Rosa"): el gestor necesita distinguir un error de tipeo de una
persona que se muda.

### `POST /homes/:id/members` — familiares

Acepta **las dos formas**: `{ userId, role }` (persona ya existente, como hoy) o
`{ person: { name, dni, ... }, role }` (alta en el mismo acto). Cupo contra
`neighborhood.max_family_members`, ya implementado, con grandfathering.

### `PATCH /neighborhoods/:id/quotas`

Suma `communityScopeEnabled`. **Solo CPS**, auditado con viejo → nuevo, como los
demás cupos.

### Sin cambios

`GET /homes`, `GET /homes/:id`, `PATCH /homes/:id`,
`DELETE /homes/:id/members/:userId`, `POST /homes/:id/transfer-titular`.
Los permisos por `managed_by` quedan como están.

---

## 8. Frontend

- **`home-form.ts`**: se va el campo Nombre; entra la sección **Titular** (nombre
  y DNI visibles, el resto plegado en "datos opcionales"); dirección y mapa pasan
  a obligatorios; al marcar el punto, la alarma preferida se precarga con la más
  cercana y muestra la distancia ("Zona Centro — a 180 m").
- **Listas** (`home-list.html`, `home-members.html`): la columna Nombre pasa a
  ser Dirección.
- **Ficha de la vivienda**: badge **"cuenta sin activar"** en cada miembro sin
  contraseña — es lo que le dice al gestor si el vecino ya entró a la app.
- **Alta de familiar**: formulario con nombre y DNI, no un selector de usuarios
  existentes.
- **Cupos del barrio**: switch "Puede activar todo el barrio", junto al de
  controles remotos.

---

## 9. Anotado, sin hacer

`plan.max_family_members` y `plan.remote_controls_enabled` **no se copian al
crear un barrio**: el barrio nace con los defaults de la base (3 y `true`). El
plan es plantilla y debería copiarse al vender (regla 4), pero hoy ese camino no
existe para los cupos de barrio. `community_scope_enabled` nace con el mismo
hueco, a propósito: arreglarlo es un trabajo aparte que toca el alta de cliente.
