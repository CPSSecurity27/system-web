# Alta de cliente — diseño completo (v2)

> **Fecha:** 2026-07-31
> **Reemplaza a** `2026-07-31-alta-de-cliente-y-contratos-design.md`, que queda
> obsoleto: ese diseño asumía que el contrato es del BARRIO, y esta versión lo
> mueve a la CUENTA. Ver §7.
> **Estado:** para revisión. Nada se implementa hasta que se apruebe.

---

## 1. El flujo, en una línea

Dar de alta un cliente es **un solo acto atómico** que termina en un usuario
OWNER operativo. Municipal y comunitaria comparten todo el flujo salvo dos
diferencias, marcadas más abajo.

```
cuenta (nombre, subtipo)
  + jurisdicción (localidad o departamento) + GPS opcional
  + plan → cupos (barrios, admin, monitor, técnico)
  + contrato (precio, desde, hasta)
  + OWNER (usuario derivado del nombre, email opcional, clave temporal)
  + barrio                                    ← SOLO la comunitaria
```

Lo único que cambia entre los dos tipos:

| | MUNICIPAL | COMMUNITY |
|---|---|---|
| Barrio en el alta | no | **sí**, su único barrio |
| Jurisdicción | se elige (localidad o departamento) | se **deriva** del barrio (siempre localidad) |
| GPS de la cuenta | se carga aparte, opcional | **el del barrio**: son el mismo lugar |
| `max_neighborhoods` | se elige (≥ 1) | **1**, invariante duro |
| `max_technician_users` | se elige | **0** por defecto, no se pregunta |

---

## 2. Decisiones tomadas

| # | Decisión | Por qué |
|---|---|---|
| 1 | La cuenta tiene **dirección propia** (jurisdicción + GPS opcional) | `account` hoy no tiene dirección; la muni necesita la de su sede, que no es ninguno de sus barrios |
| 2 | La jurisdicción tiene **nivel**: `LOCALITY` o `DEPARTMENT` | El sistema se vende a los dos niveles. Una regla fija no cubre ambos casos |
| 3 | Un barrio **solo puede crearse dentro de la jurisdicción** de su cuenta | San Pedro no crea en Ledesma (otro departamento) ni en Barro Negro (otra localidad, mismo departamento) |
| 4 | El **usuario del OWNER se deriva del nombre**, sugerido y **editable** | Menos fricción, pero el username es único global y hay casos donde el obvio no conviene |
| 5 | El **contrato es de la CUENTA**, no del barrio | El sistema se vende a nivel municipal: la muni paga por N barrios, no le revende a cada uno. Un contrato por barrio la convertiría en intermediaria de sus vecinos |
| 6 | El contrato es **obligatorio en el alta**, para los dos tipos | No existe un cliente sin contrato |
| 7 | El contrato **siempre tiene fecha de fin** | El precio es por el período; sin fin, el número no dice nada |
| 8 | El **email del OWNER es opcional** | Si está, habilita la autorecuperación de contraseña; si no, la recuperación pasa por CPS |
| 9 | El **plan sigue siendo opcional** y sus cupos editables | Obligarlo forzaría a inventar un plan por cada venta con ajuste, y el catálogo dejaría de significar algo |
| 10 | `max_technician_users = 0` en la comunitaria es **default, no invariante** | El campo de CPS lo hace CPS. Si un consorcio grande algún día quiere su técnico, es un cambio de cupo, no una migración |

### Lo que NO se toca

- La diferencia de negocio entre MUNICIPAL y COMMUNITY.
- `max_neighborhoods = 1` en la comunitaria: eso **sí** es invariante duro.
- Los cupos los modifica solo CPS, con `audit_log`.
- El DNI: es tema de vecinos y hogares, fuera de este alcance.

---

## 3. La jurisdicción

### Por qué existe

El sistema se vende **a nivel localidad o a nivel departamento**, según el
cliente. El límite de dónde puede crear barrios no es global: **depende de qué
se le vendió a ese cliente**.

Con datos reales de la base:

- **Ledesma** y **San Pedro** son dos departamentos de Jujuy (11 y 18
  localidades respectivamente).
- **"Rosario de Río Grande (ex Barro Negro)"** está **dentro** del departamento
  San Pedro, pero es otro municipio.

Una regla a nivel departamento dejaría que San Pedro cree en Barro Negro. Una
regla a nivel localidad impediría vender a un cliente departamental. Por eso el
límite se guarda **por cuenta**.

### La regla

- Cuenta con nivel `LOCALITY` → el barrio debe estar **en esa localidad**.
- Cuenta con nivel `DEPARTMENT` → el barrio debe estar **en alguna localidad de
  ese departamento**.

La provincia no se guarda ni se valida aparte: sale derivada. Si la localidad
pertenece al departamento correcto, la provincia ya es la correcta por
construcción.

### Dos condiciones

1. **La validación vive en el backend**, no en el desplegable. Que la UI filtre
   está bien, pero el que decide es el servidor: si no, alcanza un `curl`.
2. **Aplica también cuando el barrio lo crea CPS.** La regla es del cliente, no
   de quien carga.

### Si la jurisdicción quedó mal

No hay excepción por barrio — es la puerta por donde se cuela el descontrol.
Si un ejido real abarca varias localidades, **CPS corrige la jurisdicción de la
cuenta** (o se vende una cuenta aparte). Eso ya pasa por `/quotas`-style:
solo CPS, auditado.

---

## 4. El contrato

### Es de la cuenta

`service_contract` pasa a colgar de la **cuenta**. Un contrato ACTIVE por
cuenta, no por barrio.

Consecuencia directa: **los barrios ya no tienen contrato**. No existe el estado
"barrio sin contrato": si la cuenta tiene contrato vigente, todos sus barrios
están cubiertos hasta el cupo `max_neighborhoods`.

### Precio y período

El precio es **por el período del contrato**. Por eso `end_date` pasa a ser
obligatoria.

En la UI, la fecha de fin se carga con **botones de atajo** que la calculan
desde la fecha de inicio:

```
Trimestral   Semestral   Anual   [ N ] años
```

El campo de fecha queda editable para un plazo a medida.

**El período NO se guarda.** Se deriva restando las dos fechas. Es el mismo
criterio que el esquema ya aplica a los hitos del equipo: *"no hay columna de
etapa porque sería un segundo lugar donde vive el mismo dato, libre de
contradecir a las fechas"*. Guardar "anual" además de las fechas permitiría que
alguien edite una fecha y queden diciendo cosas distintas.

### Lo que habilita

Con fecha de fin obligatoria se puede listar **qué contratos vencen el mes que
viene**, que es información comercial que hoy no existe.

---

## 5. El OWNER

### Usuario derivado del nombre

Regla de derivación: minúsculas, sin acentos, espacios a `_`, sin artículos
("de", "la", "los"), recortado a 20 caracteres.

```
"Municipalidad de San Pedro"  →  municipalidad_san_p
"Consorcio Los Álamos"        →  consorcio_los_alamos
```

Se muestra **sugerido y editable**. Si está tomado, el backend responde 409 y se
corrige a mano — el username es único en todo el sistema.

### Email opcional

Si se carga, habilita que el cliente recupere su contraseña solo. Si no, cada
olvido de clave pasa por CPS.

**La clave temporal se sigue mostrando en pantalla, una sola vez**, haya email o
no. Esto es a propósito: hoy `SMTP_HOST` no está configurado y los mails se
loguean por consola, así que un alta que dependiera del correo no se podría
terminar.

---

## 6. Cambios de esquema

**Va migración**, a mano, siguiendo `backend-nestjs/docs/migraciones.md`. Los
tres lados: migración, entidad y `docs/esquema-postgres-v2.sql`.

### 6.1 Enum nuevo

```sql
CREATE TYPE jurisdiction_level AS ENUM ('LOCALITY', 'DEPARTMENT');
```

### 6.2 `account` — jurisdicción y GPS

```sql
ALTER TABLE account
  ADD COLUMN jurisdiction_level jurisdiction_level,
  ADD COLUMN locality_id   INT REFERENCES locality(id)   ON DELETE RESTRICT,
  ADD COLUMN department_id INT REFERENCES department(id) ON DELETE RESTRICT,
  ADD COLUMN latitude      DOUBLE PRECISION,
  ADD COLUMN longitude     DOUBLE PRECISION;
```

CHECK: una ORGANIZATION tiene jurisdicción y **exactamente** el id que
corresponde a su nivel; una COMPANY no tiene ninguna (CPS no tiene territorio).

```sql
ALTER TABLE account ADD CONSTRAINT chk_account_jurisdiction CHECK (
  (type = 'COMPANY'
    AND jurisdiction_level IS NULL
    AND locality_id IS NULL
    AND department_id IS NULL)
  OR
  (type = 'ORGANIZATION' AND (
     (jurisdiction_level = 'LOCALITY'
       AND locality_id IS NOT NULL AND department_id IS NULL)
     OR
     (jurisdiction_level = 'DEPARTMENT'
       AND department_id IS NOT NULL AND locality_id IS NULL)
  ))
);
```

### 6.3 `service_contract` — de barrio a cuenta

```sql
-- El contrato es de la CUENTA (el sistema se vende a nivel municipal).
DROP INDEX uq_contract_active_per_neighborhood;
ALTER TABLE service_contract DROP COLUMN neighborhood_id;

-- El precio es por el período: sin fin, el número no significa nada.
ALTER TABLE service_contract ALTER COLUMN end_date SET NOT NULL;

CREATE UNIQUE INDEX uq_contract_active_per_account
  ON service_contract(account_id) WHERE status = 'ACTIVE';
```

### 6.4 Los datos que ya están en la base rompen los dos CHECK

Esto es lo que más fácil se pasa por alto y lo que hace fallar la migración a
mitad de camino:

- **Contratos:** los 2 que hay tienen `end_date` NULL → revientan el `SET NOT NULL`.
- **Cuentas:** todas las ORGANIZATION existentes (la org 2 y las 4 `PRUEBA`)
  tienen jurisdicción NULL → revientan `chk_account_jurisdiction`.

Son **todos datos de prueba**, así que la migración los borra antes de imponer
las restricciones. Si para cuando esto se aplique hubiera datos que interesan,
hay que backfillear en lugar de borrar — decidirlo ahí, no ahora.

### 6.5 Lo que la base NO puede validar

Que el barrio caiga dentro de la jurisdicción de su cuenta cruza tres tablas
(`neighborhood` → `locality` → `department` contra `account`). **Va en el
código**, en el servicio de barrios, y se prueba con el barrido de ataques
cruzados.

---

## 7. Qué queda obsoleto del spec anterior

El spec `2026-07-31-alta-de-cliente-y-contratos-design.md` queda reemplazado.
Puntualmente dejan de valer:

| Decisión vieja | Qué pasa |
|---|---|
| "Un contrato por barrio" | **Se invierte**: el contrato es de la cuenta |
| "Barrio sin contrato: señalado, no bloqueado" | **Desaparece**: ya no existe un barrio sin contrato |
| "Firmar contrato es una acción del barrio" | **Se muda**: es una acción de la cuenta |
| "La municipalidad no puede tener contrato al crearse" | **Ya no aplica**: sin la atadura al barrio, sí puede |

Lo que **sí** sobrevive y ya está implementado (sin commitear):

- `POST /accounts/onboard-municipal` atómico — se mantiene, se le suman los
  campos nuevos.
- El contrato dentro de la transacción de `onboard-community` — se mantiene, sin
  `neighborhoodId`.
- El `@IsDefined()` en los `@ValidateNested()`, que arreglaba un 500.

---

## 8. Cambios de backend

| Cambio | Nota |
|---|---|
| Entidad `Account`: jurisdicción + GPS | Con los nombres de columna y FK reales |
| Entidad `ServiceContract`: sin `neighborhoodId`, `endDate` NOT NULL | |
| `OnboardMunicipalDto`: + jurisdicción, + GPS, + contrato, + email | El contrato pasa a obligatorio |
| `OnboardCommunityDto`: contrato sin barrio, + email | La jurisdicción se deriva del barrio |
| `onboardMunicipal` / `onboardCommunity`: crean el contrato en la transacción | Auditar `contract.create` |
| `NeighborhoodsService`: valida jurisdicción al crear barrio | Aplica también a CPS |
| `ContractsService` y su controller: sin `neighborhoodId` | Un ACTIVE por cuenta |
| Derivación del username | Función pura, testeable sola |

`permisos-check` sobre los dos endpoints de onboarding (solo CPS, mueven plata)
y sobre el alta de barrios (la validación de jurisdicción no puede depender del
front).

---

## 9. Cambios de frontend

| Cambio | Nota |
|---|---|
| `account-form`: jurisdicción (nivel + buscador), GPS opcional | Se parte a `templateUrl`: hoy son 599 líneas con el HTML adentro |
| `account-form`: contrato para los DOS tipos, con botones de plazo | Trimestral / Semestral / Anual / N años |
| `account-form`: username sugerido al tipear el nombre | Editable |
| `account-form`: email del OWNER, opcional | |
| `neighborhood-form`: localidades filtradas por la jurisdicción de la cuenta | La validación real es del backend |
| `contract-list` y ficha del cliente: contrato por cuenta | Se va la columna de barrio |

Se apoya en los componentes de la Fase 2 (`cps-page-header`, `cps-async`,
`cps-alert`, `cps-status`, `cps-paginator`), que ya existen.

---

## 10. Fuera de alcance

- El DNI y todo lo de vecinos y hogares.
- Facturación: el contrato guarda precio y período, no emite nada.
- Renovación automática de contratos vencidos.
- Excepciones de jurisdicción por barrio (decidido que no existen).
- Reparar el suite e2e del backend (`sembrar()` siembra el modelo v1) — es un
  trabajo aparte, y hasta que se haga estos cambios se verifican por API y
  navegador.
- Paleta e identidad visual (Fase 6 del rediseño).

---

## 11. Verificación

```bash
cd backend-nestjs && npx tsc --noEmit && npx eslint "src/**/*.ts" && npm test
cd frontend-angular && npx tsc --noEmit && npx ng build && npm test -- --watch=false
```

Y específicamente, por API y navegador:

1. **Atomicidad**: forzar el fallo del OWNER y verificar que **no queda cuenta**.
2. **Contrato obligatorio**: alta sin contrato → 400, en los dos tipos.
3. **Un ACTIVE por cuenta**: firmar dos veces sobre la misma cuenta → 409.
4. **Jurisdicción LOCALITY**: cuenta en San Pedro (localidad) intentando crear
   un barrio en Rosario de Río Grande → rechazado.
5. **Jurisdicción DEPARTMENT**: cuenta en San Pedro (departamento) creando un
   barrio en Rosario de Río Grande → aceptado; en Calilegua (Ledesma) →
   rechazado.
6. **La regla aplica a CPS**: el mismo intento, hecho por CPS → rechazado.
7. **Username derivado**: sugerencia correcta y 409 si está tomado.
8. **Fin del contrato**: los botones calculan bien; sin fecha de fin → 400.
9. **Barrido de ataques cruzados** de `backend-nestjs/docs/seguridad.md`.
