# Alta de cliente y contratos — diseño acordado

> **Fecha:** 2026-07-31
> **Se implementa:** después de la Fase 2 del rediseño (decisión del usuario), para
> aprovechar la capa de componentes compartidos.
> **Encaja en:** Fase 5 del spec `2026-07-31-rediseno-frontend-design.md`.

---

## 1. Por qué

El objetivo era fijar **cómo se crea un cliente**. Al revisar el código
aparecieron tres cosas que no estaban documentadas.

### 1.1 El alta ya está bifurcada por subtipo

`account-form.ts:537` se parte en dos caminos:

| Subtipo | Cómo se crea hoy |
|---|---|
| COMMUNITY | `POST /accounts/onboard-community` — cuenta + barrio + OWNER + membresía **en una transacción** |
| MUNICIPAL | Tres llamadas encadenadas **desde el front**: crear cuenta → crear usuario → crear membresía |

### 1.2 Ninguna de las dos crea contrato

`accounts.service.ts` no menciona `contract` ni una vez. **Ni siquiera la
comunitaria**, que tiene barrio desde el minuto cero y por lo tanto sí podría
firmarlo. Hoy se puede crear un consorcio completo —barrio y OWNER incluidos— y
queda sin contrato, sin que nada lo impida ni lo avise.

### 1.3 El alta MUNICIPAL puede dejar un cliente huérfano

Tres llamadas sin transacción: si falla la segunda o la tercera, queda **una
cuenta creada sin OWNER**, que nadie puede administrar. El código admite el
problema a medias ("si un paso del medio falla, el mensaje dice cuál"), pero
decir cuál falló no deshace lo ya creado.

---

## 2. Decisiones tomadas

| # | Decisión | Fundamento |
|---|---|---|
| 1 | Un cliente **MUNICIPAL puede existir sin barrios y sin contrato** | Decisión del usuario. El contrato es del barrio (`neighborhood_id` NOT NULL) y la muni crea sus barrios después, contra su cupo |
| 2 | Un cliente **COMMUNITY no puede existir sin contrato** | Su barrio nace en el mismo acto atómico, así que hay contra qué contratar |
| 3 | Un **barrio sin contrato opera igual, pero se señala** | Bloquearlo convertiría un olvido administrativo en una caída de servicio: dejaría un barrio sin alarma por un tema de papeles |
| 4 | **Contratos sigue siendo pestaña**; lo que se muda es el **alta** | `/clientes` es solo-CPS: sin la pestaña, el admin de una municipalidad se queda sin dónde ver sus contratos |

> **Nota sobre los docs.** `negocio-redisenado.md` §2.1 dice que CPS crea "la cuenta,
> su OWNER y **el contrato con sus cupos**". Eso es impreciso por dos motivos: no
> puede haber contrato sin barrio, y **los cupos no viven en el contrato** — viven
> en la cuenta, copiados del plan al vender. El contrato solo tiene precio, fechas,
> barrio y cuenta. Corregir cuando se toque ese doc.

---

## 3. Diseño

### 3.1 Alta COMMUNITY — el contrato entra al acto atómico

`POST /accounts/onboard-community` suma el contrato a la **misma transacción**
que ya crea cuenta + barrio + OWNER + membresía.

El DTO suma un bloque obligatorio:

```
contract: {
  price:       number    // NUMERIC(12,2) — obligatorio, es dinero
  startDate:   string    // DATE — obligatorio, default hoy en la UI
  endDate?:    string    // DATE — vacío = abierto / autorrenovable
  description?: string
}
```

El `service_contract` se crea con el `neighborhood_id` del barrio recién creado
y `account_id` de la cuenta recién creada, `account_type = 'ORGANIZATION'`.

**Resultado:** una comunitaria pasa a ser **imposible de crear sin contrato**.

En la UI, el formulario suma una sección "Contrato" con precio, fecha de inicio
(hoy por defecto), fecha de fin (vacía) y descripción opcional.

### 3.2 Alta MUNICIPAL — atómica, sin contrato

Endpoint nuevo `POST /accounts/onboard-municipal`: cuenta + OWNER institucional
(clave temporal) + membresía OWNER, **en una transacción**. Devuelve la misma
forma que `onboard-community`:

```
{ account, ownerUsername, temporaryPassword }
```

El front reemplaza las tres llamadas encadenadas por una. **No crea contrato**:
no hay barrio contra el cual firmarlo (decisión 1).

**Alternativa considerada y descartada:** un único `POST /accounts/onboard` que
se bifurque por `subtype` adentro. Es conceptualmente más limpio —dar de alta un
cliente es *un* acto— pero obliga a un DTO condicional (barrio y contrato
obligatorios solo si COMMUNITY) y a tocar un endpoint que hoy funciona. Se
prefiere el par de endpoints por menor riesgo.

### 3.3 Firmar contrato es una acción del BARRIO

- `/contratos/nuevo` **deja de existir** como formulario suelto que te hace
  elegir organización y barrio de dos listas largas.
- `/barrios/:id` gana una sección **Contrato**: muestra el activo (precio,
  desde, hasta, estado) o el vacío señalado, con botón **"Firmar contrato"**
  visible solo para CPS.
- El barrio es donde uno está parado cuando el contrato importa, y ya conoce su
  propia identidad: el formulario no tiene que preguntarla.

`/contratos` (la lista) **se mantiene** tal cual está, con su alcance actual:
CPS ve todos, la organización ve los suyos.

### 3.4 Barrio sin contrato: señalado, no bloqueado

- En `/barrios` (listado) y en `/barrios/:id`: distintivo **"Sin contrato"** en
  tono de advertencia.
- En la ficha del cliente: sus barrios con el estado de contrato de cada uno.
- **No bloquea nada**: el barrio recibe alarmas, vecinos y eventos igual.

Requiere que el backend exponga el contrato activo (o su ausencia) en el listado
y el detalle de barrios. Hoy no lo hace.

---

## 4. Impacto

### Backend

| Cambio | Nota |
|---|---|
| `OnboardCommunityDto` suma el bloque `contract` | Obligatorio |
| `onboardCommunity` crea el `service_contract` en la transacción | Alta sensible → `AuditService` |
| Endpoint nuevo `POST /accounts/onboard-municipal` | Solo CPS, transaccional |
| Listado y detalle de barrios exponen el contrato activo | Para el distintivo "Sin contrato" |

**Sin migraciones.** El esquema ya soporta todo esto: `service_contract` existe
con su índice único parcial de un ACTIVE por barrio, y el 23505 ya se traduce a
409.

`permisos-check` sobre los dos endpoints de onboarding: son solo-CPS y mueven
plata. Y sobre el listado de barrios, que suma un campo nuevo — el contrato de un
barrio ajeno no puede salir del servidor.

### Frontend

| Cambio | Nota |
|---|---|
| `account-form` suma la sección Contrato (solo COMMUNITY) | Es el archivo de 599 líneas: se parte a `templateUrl` acá |
| `account-form` MUNICIPAL pasa a una sola llamada | Se va el encadenamiento |
| `neighborhood-detail` suma la sección Contrato + "Firmar" | Solo CPS |
| `contract-form` deja de ser ruta suelta | Su contenido se reusa dentro del barrio |
| `neighborhood-list` y ficha del cliente muestran "Sin contrato" | Decisión 3 |

---

## 5. Fuera de alcance

- **No se bloquea** ningún barrio por falta de contrato (decisión 3).
- **No se exige** barrio ni contrato al crear una municipalidad (decisión 1).
- No se unifica el onboarding en un solo endpoint (§3.2).
- No se tocan cupos, planes ni `audit_log` más allá de registrar el contrato nuevo.
- No se define paleta ni identidad visual (Fase 6 del rediseño).

---

## 6. Verificación

```bash
cd backend-nestjs
npx tsc --noEmit && npx eslint "src/**/*.ts" && npm test
```

```bash
cd frontend-angular
npx tsc --noEmit && npx ng build && npm test -- --watch=false
```

Más, específicamente:

- **Atomicidad:** forzar el fallo del paso del OWNER en `onboard-municipal` y
  verificar que **no queda cuenta creada**. Es el bug que este diseño cierra: si
  el test no lo prueba, no está cerrado.
- **Comunitaria sin contrato:** verificar que el alta la rechaza.
- **Un ACTIVE por barrio:** firmar dos veces sobre el mismo barrio → 409.
- **Barrido de ataques cruzados** de `backend-nestjs/docs/seguridad.md`: una
  organización no puede ver el contrato de un barrio ajeno.
