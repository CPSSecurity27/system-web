# Provisioner del broker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que fabricar un equipo desde la web registre su credencial en el broker MQTT sin que nadie corra un comando a mano, y que se pueda revocar con un botón.

**Architecture:** La web encola en `gtd.provisioning_queue` (misma transacción que el alta) y un proceso nuevo y privilegiado —`python -m gtd.provisioner`, aparte del GtD— drena la cola invocando `deploy/provision-panel.sh`, y confirma por función SQL. Sin túnel HTTP: web y provisioner solo comparten la base.

**Tech Stack:** PostgreSQL (PL/pgSQL, esquema `gtd`) · NestJS + TypeORM · Angular 21 (signals) · Python 3.11 + asyncpg · Bash · systemd.

## Global Constraints

- **Diseño de referencia:** `docs/superpowers/specs/2026-08-04-provisioner-broker-design.md`. Ante duda, manda la spec.
- **Idioma:** español rioplatense (voseo) en docs, comentarios, mensajes de error y textos de UI.
- **El SQL manda:** migraciones **a mano**, nunca `migration:generate`. Toda columna va en la migración *y* en la entidad, a mano, en los dos lados. Ver `backend-nestjs/docs/migraciones.md`.
- **Numeración de migraciones:** la última aplicada es `1786500000000-GtdConfigFunctions`. La nueva arranca en `1786600000000`.
- **Permisos:** el ROL dice QUÉ (`@RequireMembership`) y el ALCANCE dice DÓNDE (`ScopeService`). **Los dos, siempre.** Un endpoint con `:id` que solo valide rol es un bug — pasó en el plan 2 con el MONITOR.
- **Ningún secreto en la base ni en un log.** La password se deriva en el momento; la cola no la guarda. El `SALT_MQTT` vive **solo** en el entorno del provisioner, nunca en la web.
- **El GtD no se toca.** `deploy/gateway-to-device.service` queda exactamente como está: su endurecimiento (`NoNewPrivileges`, `ProtectSystem=strict`) es lo que justifica que el provisioner sea un proceso aparte.
- **No se despliega nada.** Decisión del usuario (2026-08-04): el trabajo queda local. La Raspberry no se toca en ninguna tarea de este plan.
- **Verificación backend:** `npx tsc --noEmit && npx eslint "src/**/*.ts" && npm test` desde `backend-nestjs/`.
- **Verificación GtD:** `.venv/Scripts/python.exe -m pytest tests/ -q` desde `gateway-to-device/`.
- **Base local:** `cps_security_v2`, admin `postgres`/`root`. `psql` en `C:\Program Files\PostgreSQL\18\bin\psql.exe`; **siempre** `$env:PGPASSWORD` antes de invocarlo. PowerShell se come las comillas del JSON en `psql -c`: el SQL con JSON va **por archivo** (`-f`).
- **Commits:** sin `Co-Authored-By`, sin firmas de IA.

---

## File Structure

**Se crean:**

| Archivo | Responsabilidad |
|---|---|
| `backend-nestjs/src/database/migrations/1786600000000-ProvisioningQueue.ts` | Tabla, trigger de `NOTIFY`, 3 funciones y GRANTs |
| `backend-nestjs/src/devices/provisioning.service.ts` | Encolar y consultar la cola desde la web |
| `gateway-to-device/src/gtd/provisioner/__init__.py` | Paquete |
| `gateway-to-device/src/gtd/provisioner/__main__.py` | Bucle de servicio: LISTEN + barrido |
| `gateway-to-device/src/gtd/provisioner/cola.py` | Acceso a la base (asyncpg) |
| `gateway-to-device/src/gtd/provisioner/broker.py` | Invoca `provision-panel.sh` |
| `gateway-to-device/deploy/cps-provisioner.service` | Unit propio, privilegios propios |
| `gateway-to-device/tests/test_provisioner.py` | Tests del provisioner |
| `backend-nestjs/test/provisioning.e2e-spec.ts` | Integración de los endpoints |

**Se modifican:**

| Archivo | Cambio |
|---|---|
| `backend-nestjs/src/devices/devices.service.ts` | Encolar `provision` al crear el equipo |
| `backend-nestjs/src/devices/devices.controller.ts` | 2 endpoints nuevos |
| `backend-nestjs/src/devices/devices.module.ts` | Registrar el servicio |
| `backend-nestjs/src/devices/dto/device-view.ts` | Estado de la cola en `DeviceProvisioning` |
| `backend-nestjs/docs/migraciones.md`, `docs/activos.md` | Documentar |
| `docs/roles-conexion-v2.sql`, `docs/esquema-postgres-v2.sql` | Rol y funciones nuevas |
| `gateway-to-device/deploy/provision-panel.sh` | `--no-reload`, `--no-probe`, `revoke` |
| `gateway-to-device/deploy/README.md` | Corregir "Postgres no está instalado" y documentar el provisioner |
| `frontend-angular/src/app/core/models/api.models.ts` | Tipos |
| `frontend-angular/src/app/core/api/devices.service.ts` | 2 métodos |
| `frontend-angular/src/app/features/devices/device-detail.html` | Bloque de provisioning con estados |

---

## Task 1: La cola, las funciones y el rol

**Files:**
- Create: `backend-nestjs/src/database/migrations/1786600000000-ProvisioningQueue.ts`
- Modify: `docs/roles-conexion-v2.sql`, `docs/esquema-postgres-v2.sql`, `backend-nestjs/docs/migraciones.md`

**Interfaces:**
- Consumes: tablas `device`, `app_user`, `audit_log`; esquema `gtd` (del plan 1)
- Produces: `gtd.enqueue_provisioning(INT, TEXT, INT) → BIGINT`, `gtd.fetch_pending_provisioning() → TABLE(id BIGINT, mac TEXT, op TEXT)`, `gtd.confirm_provisioning(BIGINT, TEXT, TEXT) → TEXT`, rol `cps_provisioner`

- [ ] **Step 1: Escribir la migración**

Crear `backend-nestjs/src/database/migrations/1786600000000-ProvisioningQueue.ts`:

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Alta y baja de equipos en el broker MQTT (2026-08-04).
 *
 * Ver `docs/superpowers/specs/2026-08-04-provisioner-broker-design.md`.
 *
 * La web encola acá y un proceso APARTE del GtD (el provisioner) drena la cola
 * invocando `deploy/provision-panel.sh`. Aparte y no adentro del GtD porque el
 * GtD está deliberadamente encerrado (`NoNewPrivileges`, `ProtectSystem=strict`)
 * y registrar en el broker necesita justo lo contrario: escribir
 * /etc/mosquitto/gtd.passwd y recargar el servicio. Meterlo adentro sería
 * desarmar ese encierro en el único proceso expuesto a cada panel por MQTT.
 *
 * La cola NO guarda ninguna password: la credencial se deriva en el momento con
 * el SALT_MQTT, que vive solo en el entorno del provisioner.
 *
 * Es un HISTÓRICO, una fila por operación y no una por equipo: saber que un
 * equipo se revocó en marzo y se volvió a registrar en julio es información
 * operativa que un UPDATE in place borraría.
 */
export class ProvisioningQueue1786600000000 implements MigrationInterface {
  name = 'ProvisioningQueue1786600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE gtd.provisioning_queue (
        id           BIGSERIAL PRIMARY KEY,
        mac          TEXT NOT NULL,
        device_id    INT  NOT NULL REFERENCES device(id) ON DELETE CASCADE,
        op           TEXT NOT NULL,
        estado       TEXT NOT NULL DEFAULT 'pending',
        detalle      TEXT,
        requested_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        done_at      TIMESTAMPTZ,

        CONSTRAINT chk_prov_op     CHECK (op IN ('provision', 'revoke')),
        CONSTRAINT chk_prov_estado CHECK (estado IN ('pending', 'done', 'failed'))
      )
    `);

    await queryRunner.query(`
      COMMENT ON TABLE gtd.provisioning_queue IS
        'Alta/baja de credenciales en el broker. La drena el provisioner (proceso aparte del GtD). No guarda passwords: se derivan del SALT_MQTT.'
    `);

    // Mismo criterio que ix_commands_pending: el barrido solo mira pendientes.
    await queryRunner.query(`
      CREATE INDEX ix_provisioning_pending
        ON gtd.provisioning_queue(created_at) WHERE estado = 'pending'
    `);
    await queryRunner.query(`
      CREATE INDEX ix_provisioning_device
        ON gtd.provisioning_queue(device_id, created_at DESC)
    `);

    // ── enqueue: la llama la web ──────────────────────────────────────
    await queryRunner.query(`
      CREATE FUNCTION gtd.enqueue_provisioning(
        p_device_id INT,
        p_op        TEXT,
        p_user_id   INT DEFAULT NULL
      ) RETURNS BIGINT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_mac TEXT;
        v_id  BIGINT;
      BEGIN
        IF p_op NOT IN ('provision', 'revoke') THEN
          RAISE EXCEPTION 'Operación inválida: %', p_op;
        END IF;

        SELECT mac INTO v_mac FROM device WHERE id = p_device_id;
        IF v_mac IS NULL THEN
          RAISE EXCEPTION 'El equipo % no existe o no tiene MAC cargada', p_device_id;
        END IF;

        -- Encolar dos veces la misma operación no sirve de nada: el script es
        -- idempotente y el segundo pedido haría el mismo trabajo dos veces.
        SELECT id INTO v_id
          FROM gtd.provisioning_queue
         WHERE device_id = p_device_id AND op = p_op AND estado = 'pending'
         LIMIT 1;
        IF v_id IS NOT NULL THEN
          RETURN v_id;
        END IF;

        INSERT INTO gtd.provisioning_queue (mac, device_id, op, requested_by)
        VALUES (v_mac, p_device_id, p_op, p_user_id)
        RETURNING id INTO v_id;

        RETURN v_id;
      END;
      $fn$
    `);

    // ── fetch: la llama el provisioner ────────────────────────────────
    await queryRunner.query(`
      CREATE FUNCTION gtd.fetch_pending_provisioning()
      RETURNS TABLE (id BIGINT, mac TEXT, op TEXT)
      LANGUAGE sql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
        SELECT q.id, q.mac, q.op
          FROM gtd.provisioning_queue q
         WHERE q.estado = 'pending'
         ORDER BY q.created_at;
      $fn$
    `);

    // ── confirm: la llama el provisioner ──────────────────────────────
    await queryRunner.query(`
      CREATE FUNCTION gtd.confirm_provisioning(
        p_id  BIGINT,
        p_res TEXT,
        p_det TEXT DEFAULT NULL
      ) RETURNS TEXT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_fila gtd.provisioning_queue%ROWTYPE;
      BEGIN
        SELECT * INTO v_fila FROM gtd.provisioning_queue
         WHERE id = p_id AND estado = 'pending';
        IF NOT FOUND THEN
          RETURN 'noop';
        END IF;

        IF p_res = 'ok' THEN
          UPDATE gtd.provisioning_queue
             SET estado = 'done', detalle = NULL, done_at = now()
           WHERE id = p_id;

          -- El hito solo se mueve cuando el broker lo aceptó de verdad.
          UPDATE device
             SET mqtt_provisioned_at = CASE WHEN v_fila.op = 'provision'
                                            THEN now() ELSE NULL END,
                 mqtt_provisioned_by = v_fila.requested_by
           WHERE id = v_fila.device_id;
        ELSE
          -- Un fallo NO toca `device`: el equipo queda como estaba y la fila
          -- explica por qué. No se reintenta solo — los tres modos de falla
          -- (salt equivocado, broker roto, equipo inválido) piden una persona.
          UPDATE gtd.provisioning_queue
             SET estado = 'failed', detalle = COALESCE(p_det, 'sin detalle'),
                 done_at = now()
           WHERE id = p_id;
        END IF;

        INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, new_value)
        VALUES (v_fila.requested_by,
                'device.broker.' || v_fila.op,
                'device', v_fila.device_id,
                jsonb_build_object('res', p_res, 'detalle', p_det, 'mac', v_fila.mac));

        RETURN 'ok';
      END;
      $fn$
    `);

    // ── NOTIFY ────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE FUNCTION gtd.notify_gtd_provisioning() RETURNS TRIGGER
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.estado = 'pending' THEN
          PERFORM pg_notify('gtd_provisioning', NEW.mac);
        END IF;
        RETURN NEW;
      END;
      $fn$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_provisioning_notify
        AFTER INSERT OR UPDATE ON gtd.provisioning_queue
        FOR EACH ROW EXECUTE FUNCTION gtd.notify_gtd_provisioning()
    `);

    // ── Permisos ──────────────────────────────────────────────────────
    // PUBLIC tiene EXECUTE por defecto en toda función nueva: sin este REVOKE,
    // revocarle a un rol puntual no sirve de nada.
    await queryRunner.query(`
      REVOKE EXECUTE ON FUNCTION
        gtd.enqueue_provisioning(INT, TEXT, INT),
        gtd.fetch_pending_provisioning(),
        gtd.confirm_provisioning(BIGINT, TEXT, TEXT)
      FROM PUBLIC
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_web') THEN
          REVOKE ALL ON gtd.provisioning_queue FROM cps_web;
          GRANT EXECUTE ON FUNCTION
            gtd.enqueue_provisioning(INT, TEXT, INT) TO cps_web;
          -- La web LEE la cola para mostrar el estado en la ficha.
          GRANT SELECT ON gtd.provisioning_queue TO cps_web;
        END IF;

        -- El rol del provisioner. No puede encolar (eso es de la web) ni tocar
        -- ninguna función del GtD.
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_provisioner') THEN
          REVOKE ALL ON gtd.provisioning_queue FROM cps_provisioner;
          GRANT USAGE ON SCHEMA gtd TO cps_provisioner;
          GRANT EXECUTE ON FUNCTION
            gtd.fetch_pending_provisioning(),
            gtd.confirm_provisioning(BIGINT, TEXT, TEXT)
          TO cps_provisioner;
        END IF;

        -- El GtD no participa del alta: no se le da nada.
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_alarms') THEN
          REVOKE ALL ON gtd.provisioning_queue FROM cps_alarms;
        END IF;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_provisioning_notify ON gtd.provisioning_queue`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS gtd.notify_gtd_provisioning()`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS gtd.confirm_provisioning(BIGINT, TEXT, TEXT)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS gtd.fetch_pending_provisioning()`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS gtd.enqueue_provisioning(INT, TEXT, INT)`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS gtd.provisioning_queue`);
  }
}
```

- [ ] **Step 2: Crear el rol nuevo en la base local**

```powershell
$env:PGPASSWORD="root"
$psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
& $psql -U postgres -h localhost -d postgres -c "CREATE ROLE cps_provisioner LOGIN PASSWORD 'CpsProv2026!'"
```

Si ya existe, el error `role already exists` es benigno.

- [ ] **Step 3: Aplicar y verificar up → down → up**

```powershell
cd backend-nestjs
npm run migration:run
npm run migration:revert
npm run migration:run
```

Expected: las tres corren sin error.

- [ ] **Step 4: Probar con los roles reales**

Guardar en un archivo `fixture-prov.sql` (por archivo, no `-c`, por el problema de comillas de PowerShell):

```sql
INSERT INTO board_model (code, name) VALUES ('ALOY','Aloy') ON CONFLICT (code) DO NOTHING;
INSERT INTO device (serial, mac, type, status, board_model_id, board_seq)
VALUES ('AV-AABBCCDDEE99','AABBCCDDEE99','COMMUNITY_ALARM','INVENTORY',
        (SELECT id FROM board_model WHERE code='ALOY'), 9999)
ON CONFLICT (serial) DO NOTHING;
```

Después:

```powershell
$psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
$env:PGPASSWORD="root"
& $psql -U postgres -h localhost -d cps_security_v2 -q -f fixture-prov.sql
$id = & $psql -U postgres -h localhost -d cps_security_v2 -tAc "SELECT id FROM device WHERE mac='AABBCCDDEE99'"

# 1. Encolar (como cps_web)
$env:PGPASSWORD="CpsWeb2026!"
& $psql -U cps_web -h localhost -d cps_security_v2 -tAc "SELECT gtd.enqueue_provisioning($id, 'provision', NULL)"
# 2. Encolar de nuevo: tiene que devolver el MISMO id
& $psql -U cps_web -h localhost -d cps_security_v2 -tAc "SELECT gtd.enqueue_provisioning($id, 'provision', NULL)"
# 3. cps_web NO puede confirmar
& $psql -U cps_web -h localhost -d cps_security_v2 -tAc "SELECT gtd.confirm_provisioning(1,'ok')"

# 4. El provisioner SÍ lee y confirma
$env:PGPASSWORD="CpsProv2026!"
& $psql -U cps_provisioner -h localhost -d cps_security_v2 -c "SELECT id, mac, op FROM gtd.fetch_pending_provisioning()"
# 5. cps_provisioner NO puede encolar
& $psql -U cps_provisioner -h localhost -d cps_security_v2 -tAc "SELECT gtd.enqueue_provisioning($id,'provision',NULL)"
```

Expected: (1) devuelve un id; (2) **el mismo id**; (3) **permiso denegado**; (4) devuelve la fila; (5) **permiso denegado**.

- [ ] **Step 5: Probar confirm y el hito**

```powershell
$env:PGPASSWORD="CpsProv2026!"
$qid = & $psql -U cps_provisioner -h localhost -d cps_security_v2 -tAc "SELECT id FROM gtd.fetch_pending_provisioning() LIMIT 1"
& $psql -U cps_provisioner -h localhost -d cps_security_v2 -tAc "SELECT gtd.confirm_provisioning($qid, 'ok')"
$env:PGPASSWORD="root"
& $psql -U postgres -h localhost -d cps_security_v2 -c "SELECT (mqtt_provisioned_at IS NOT NULL) AS provisionado FROM device WHERE mac='AABBCCDDEE99'"
& $psql -U postgres -h localhost -d cps_security_v2 -c "SELECT count(1) FROM audit_log WHERE action='device.broker.provision'"
```

Expected: `confirm` devuelve `ok`, `provisionado` es `t`, y hay una fila en `audit_log`.

Después probar el camino de error y el `revoke`:

```powershell
$env:PGPASSWORD="CpsWeb2026!"
& $psql -U cps_web -h localhost -d cps_security_v2 -tAc "SELECT gtd.enqueue_provisioning($id,'revoke',NULL)"
$env:PGPASSWORD="CpsProv2026!"
$qid2 = & $psql -U cps_provisioner -h localhost -d cps_security_v2 -tAc "SELECT id FROM gtd.fetch_pending_provisioning() LIMIT 1"
& $psql -U cps_provisioner -h localhost -d cps_security_v2 -tAc "SELECT gtd.confirm_provisioning($qid2,'error','mosquitto no arranco')"
$env:PGPASSWORD="root"
& $psql -U postgres -h localhost -d cps_security_v2 -c "SELECT estado, detalle FROM gtd.provisioning_queue WHERE id=$qid2"
& $psql -U postgres -h localhost -d cps_security_v2 -c "SELECT (mqtt_provisioned_at IS NOT NULL) AS sigue_provisionado FROM device WHERE mac='AABBCCDDEE99'"
```

Expected: la fila queda `failed` con el detalle, y **`sigue_provisionado` es `t`** — un fallo no toca `device`.

- [ ] **Step 6: Limpiar el fixture**

```powershell
& $psql -U postgres -h localhost -d cps_security_v2 -q -c "DELETE FROM gtd.provisioning_queue WHERE mac='AABBCCDDEE99'; DELETE FROM device WHERE mac='AABBCCDDEE99';"
```

- [ ] **Step 7: Documentar**

En `backend-nestjs/docs/migraciones.md`, agregar antes de la nota final:

```markdown
| `1786600000000-ProvisioningQueue` | Alta y baja de equipos en el broker: tabla `gtd.provisioning_queue` (histórica, una fila por operación, sin passwords), `enqueue_provisioning` / `fetch_pending_provisioning` / `confirm_provisioning`, canal `gtd_provisioning` y el rol `cps_provisioner` (solo lee la cola y confirma; no puede encolar ni tocar las funciones del GtD) |
```

En `docs/roles-conexion-v2.sql`, agregar el rol y sus GRANTs siguiendo el estilo del archivo (bloque `CREATE ROLE` comentado arriba, `GRANT EXECUTE` abajo). En `docs/esquema-postgres-v2.sql` §13, transcribir las tres funciones con su porqué.

- [ ] **Step 8: Verificar y commitear**

```bash
cd backend-nestjs && npx tsc --noEmit && npx eslint "src/**/*.ts" && npm test
cd .. && git add -A
git commit -m "Cola de provisioning: la web encola y el provisioner confirma, con rol propio"
```

---

## Task 2: Encolar al fabricar, y los dos endpoints

**Files:**
- Create: `backend-nestjs/src/devices/provisioning.service.ts`
- Modify: `backend-nestjs/src/devices/devices.service.ts`, `devices.controller.ts`, `devices.module.ts`, `dto/device-view.ts`

**Interfaces:**
- Consumes: `gtd.enqueue_provisioning` (Task 1), `ScopeService`, `AuditService`
- Produces: `ProvisioningService.encolar(deviceId, op, userId)`, `ProvisioningService.estadoDe(deviceId)`, endpoints `POST /devices/:id/provision` y `POST /devices/:id/revoke-credential`, y el campo `queue` en `DeviceProvisioning`

- [ ] **Step 1: Escribir el servicio**

Crear `backend-nestjs/src/devices/provisioning.service.ts`:

```ts
import { ConflictException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AccessScope, ScopeService } from '../common/scope.service';
import { DevicesService } from './devices.service';

export type ProvisioningOp = 'provision' | 'revoke';
export type ProvisioningEstado = 'pending' | 'done' | 'failed';

export interface ProvisioningQueueView {
  op: ProvisioningOp;
  estado: ProvisioningEstado;
  detalle: string | null;
  createdAt: string;
}

interface ColaRow {
  op: ProvisioningOp;
  estado: ProvisioningEstado;
  detalle: string | null;
  created_at: Date;
}

/**
 * Alta y baja de la credencial del equipo en el broker MQTT.
 *
 * La web NO registra nada: encola en `gtd.provisioning_queue` y un proceso
 * aparte (el provisioner, en el repo del GtD) hace el trabajo con privilegios
 * que la web no tiene ni tiene por qué tener. Acá nunca se ve el `SALT_MQTT`.
 *
 * Ver `docs/superpowers/specs/2026-08-04-provisioner-broker-design.md`.
 */
@Injectable()
export class ProvisioningService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly devices: DevicesService,
    private readonly scopes: ScopeService,
  ) {}

  /**
   * Encola una operación. Con `manager` participa de la transacción de quien
   * llama — así el alta del equipo y su encolado son atómicos: no puede quedar
   * un equipo fabricado sin pedido de credencial.
   */
  async encolar(
    deviceId: number,
    op: ProvisioningOp,
    userId: number | null,
    manager?: EntityManager,
  ): Promise<number> {
    const runner = manager ?? this.dataSource;
    try {
      const filas = (await runner.query(
        `SELECT gtd.enqueue_provisioning($1, $2, $3) AS id`,
        [deviceId, op, userId],
      )) as { id: string }[];
      return Number(filas[0].id);
    } catch (e) {
      // La función levanta excepciones con mensajes para el usuario
      // ("no existe o no tiene MAC cargada"): se traducen tal cual.
      throw new ConflictException((e as Error).message);
    }
  }

  /** Pedido por un humano: valida rol (controller) y alcance (acá). */
  async pedir(
    deviceId: number,
    op: ProvisioningOp,
    scope: AccessScope,
    userId: number,
  ): Promise<{ mensaje: string }> {
    const device = await this.devices.findOne(deviceId, scope);
    if (device.neighborhoodId !== null) {
      await this.scopes.assertNeighborhood(scope, device.neighborhoodId);
    }

    await this.encolar(deviceId, op, userId);
    return {
      mensaje:
        op === 'provision'
          ? 'Se pidió el alta de la credencial en el broker.'
          : 'Se pidió la baja de la credencial en el broker.',
    };
  }

  /** La última operación del equipo, para mostrarla en la ficha. */
  async estadoDe(deviceId: number): Promise<ProvisioningQueueView | null> {
    const filas = (await this.dataSource.query(
      `SELECT op, estado, detalle, created_at
         FROM gtd.provisioning_queue
        WHERE device_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [deviceId],
    )) as ColaRow[];

    const fila = filas[0];
    if (!fila) return null;
    return {
      op: fila.op,
      estado: fila.estado,
      detalle: fila.detalle,
      createdAt: fila.created_at.toISOString(),
    };
  }
}
```

- [ ] **Step 2: Encolar al crear el equipo**

En `backend-nestjs/src/devices/devices.service.ts`, en `create()`, después del `await this.audit.record({ action: 'device.create', ... })` y antes de `device.boardModel = boardModel;`, agregar:

```ts
    // El alta de fábrica pide la credencial del broker sola: es lo que hace
    // posible fabricar una tanda sin correr un comando por equipo. Si el
    // provisioner está caído, la fila queda pendiente y se toma al arrancar.
    await this.provisioning.encolar(device.id, 'provision', createdBy);
```

Y agregar al constructor de `DevicesService`:

```ts
    @Inject(forwardRef(() => ProvisioningService))
    private readonly provisioning: ProvisioningService,
```

con los imports `Inject`, `forwardRef` de `@nestjs/common` y `ProvisioningService` de `./provisioning.service`. El `forwardRef` hace falta porque `ProvisioningService` inyecta `DevicesService`: es una dependencia circular real y Nest la resuelve así.

- [ ] **Step 3: Registrar en el módulo**

En `backend-nestjs/src/devices/devices.module.ts`, agregar `ProvisioningService` al array `providers`:

```ts
  providers: [DevicesService, DeviceConfigService, ProvisioningService],
```

con su import.

- [ ] **Step 4: Sumar el estado de la cola a la vista**

En `backend-nestjs/src/devices/dto/device-view.ts`, agregar al final de la interfaz `DeviceProvisioning`:

```ts
  /**
   * La última operación de alta/baja pedida, o null si nunca se pidió ninguna.
   * Lo llena `DevicesService.findOne`; en los listados va null (una consulta por
   * equipo en una lista de 200 no vale la pena).
   */
  queue: {
    op: 'provision' | 'revoke';
    estado: 'pending' | 'done' | 'failed';
    detalle: string | null;
    createdAt: string;
  } | null;
```

Y en `toProvisioning()`, agregar `queue: null` al objeto devuelto (lo completa el `findOne`, no el builder puro).

En `DevicesService.findOne()`, después de armar la vista, si tiene `provisioning`, completarlo:

```ts
    const vista = toDeviceView(device);
    if (vista.provisioning) {
      vista.provisioning.queue = await this.provisioning.estadoDe(id);
    }
    return vista;
```

- [ ] **Step 5: Los dos endpoints**

En `backend-nestjs/src/devices/devices.controller.ts`, después de los endpoints de configuración:

```ts
  /**
   * POST /api/devices/:id/provision — pedir el alta de la credencial.
   *
   * Sirve para reintentar un alta fallida y para los equipos que ya existen sin
   * registrar: no hace falta un backfill aparte. El alta de fábrica ya encola
   * sola, así que esto es la excepción, no el camino normal.
   */
  @Post(':id/provision')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
  })
  async pedirProvision(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ mensaje: string }> {
    return this.provisioning.pedir(
      id,
      'provision',
      await this.scopes.forUser(user),
      user.id,
    );
  }

  /**
   * POST /api/devices/:id/revoke-credential — dar de baja la credencial.
   *
   * SIEMPRE manual, nunca automático: ningún cambio de estado del equipo revoca
   * nada (decisión de negocio, 2026-08-04). Es el camino para un equipo robado,
   * reemplazado o dado de baja.
   */
  @Post(':id/revoke-credential')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
  })
  async revocarCredencial(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ mensaje: string }> {
    return this.provisioning.pedir(
      id,
      'revoke',
      await this.scopes.forUser(user),
      user.id,
    );
  }
```

Agregar `private readonly provisioning: ProvisioningService,` al constructor y su import.

- [ ] **Step 6: Verificar que compila y arranca**

```bash
cd backend-nestjs
npx tsc --noEmit && npx eslint "src/**/*.ts" && npm test
npm run build && timeout 40 node dist/main.js 2>&1 | grep -E "provision|revoke-credential|successfully started"
```

Expected: las dos rutas mapeadas y la app arranca. Si Nest se queja de dependencia circular, revisar que el `forwardRef` del Step 2 esté puesto en los dos lados.

- [ ] **Step 7: Commit**

```bash
git add backend-nestjs/src/devices/
git commit -m "Alta de fábrica encola la credencial del broker; botones de alta y baja"
```

---

## Task 3: Integración de los endpoints

**Files:**
- Create: `backend-nestjs/test/provisioning.e2e-spec.ts`

**Interfaces:**
- Consumes: los endpoints de la Task 2, `gtd.provisioning_queue` de la Task 1

- [ ] **Step 1: Escribir el test**

Crear `backend-nestjs/test/provisioning.e2e-spec.ts`. **No usar `sembrar()` de `helpers.ts`**: arma el modelo v1 y su suite está en rojo. Copiar el fixture v2 de `test/device-config.e2e-spec.ts` (el `beforeAll` que crea geografía, CPS, organización, barrios y equipos) y adaptarlo.

Recordatorios del esquema, que ya mordieron antes:
- `account_user` **no tiene** `account_type`.
- Una `ORGANIZATION` exige los cinco cupos + coordenadas + jurisdicción.
- `chk_device_stock_owner` reserva `organization_id` para el stock: un equipo instalado lo lleva en NULL.
- `chk_device_identity` exige `board_model_id`, `board_seq` y `serial = 'AV-' || mac`.

Los casos:

```ts
describe('Provisioning en el broker (e2e)', () => {
  it('el alta de fábrica encola un provision sola', async () => {
    // POST /api/devices con MAC + boardNumber, como CPS.
    // → gtd.provisioning_queue tiene 1 fila op=provision estado=pending
    //   para ese device_id.
  });

  it('la ficha muestra el estado de la cola', async () => {
    // GET /api/devices/:id → provisioning.queue.estado === 'pending'
  });

  it('pedir provision dos veces no encola dos filas', async () => {
    // POST /:id/provision dos veces → sigue habiendo 1 sola pending.
  });

  it('revoke encola una fila op=revoke', async () => {});

  it('la organización no puede pedir el alta (403)', async () => {
    // Solo CPS: es infraestructura del broker.
  });

  it('el MONITOR de CPS tampoco (403)', async () => {});

  it('un equipo sin MAC devuelve 409 con un mensaje que lo explica', async () => {
    // Crear un device de otro `type` sin mac, directo por SQL.
  });

  it('confirmar el alta escribe el hito y deja audit_log', async () => {
    // Simular al provisioner: SELECT gtd.confirm_provisioning(id, 'ok')
    // → device.mqtt_provisioned_at deja de ser null
    // → GET /api/devices/:id → provisioning.brokerRegistered === true
  });

  it('confirmar con error NO toca el equipo', async () => {
    // confirm_provisioning(id, 'error', 'mosquitto no arranco')
    // → la fila queda failed con el detalle
    // → mqtt_provisioned_at NO cambió
  });
});
```

Implementar cada caso con su fixture.

- [ ] **Step 2: Correr**

Run: `cd backend-nestjs && npx jest --config ./test/jest-e2e.json test/provisioning.e2e-spec.ts --runInBand`
Expected: los 9 pasan.

- [ ] **Step 3: Commit**

```bash
git add backend-nestjs/test/provisioning.e2e-spec.ts
git commit -m "Integración del provisioning: solo CPS, sin duplicar, y un fallo no mueve el hito"
```

---

## Task 4: Los tres agregados al script

**Files:**
- Modify: `gateway-to-device/deploy/provision-panel.sh`

**Interfaces:**
- Produces: flags `--no-reload` y `--no-probe`, y el modo `revoke <MAC>`

- [ ] **Step 1: Parsear los flags**

En `gateway-to-device/deploy/provision-panel.sh`, después de `RAW_MAC="$1"; shift` (línea ~33), reemplazar el parseo actual por:

```bash
# ── Modo y flags ────────────────────────────────────────────────────
# `revoke` da de baja la credencial. Los flags existen para el provisioner:
# con una tanda de equipos, recargar y verificar UNA vez al final en vez de
# por equipo (ver docs/superpowers/specs/2026-08-04-provisioner-broker-design.md).
MODO_OP="provision"
DO_RELOAD=1
DO_PROBE=1

if [ "$RAW_MAC" = "revoke" ]; then
  MODO_OP="revoke"
  RAW_MAC="${1:-}"; shift || true
  [ -n "$RAW_MAC" ] || die "Uso: sudo -E bash $0 revoke <MAC>"
fi

TOPIC_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-reload) DO_RELOAD=0 ;;
    --no-probe)  DO_PROBE=0 ;;
    *)           TOPIC_ARGS+=("$1") ;;
  esac
  shift
done
set -- "${TOPIC_ARGS[@]}"
```

- [ ] **Step 2: Cortar temprano si es `revoke`**

Después del bloque que arma `USERNAME` y `TOPIC_IDS` (línea ~50, antes de la sección de la password), insertar:

```bash
# ── revoke: se va la credencial y listo ─────────────────────────────
# La ACL no se toca: la regla `pattern av/%u/…` es de flota y no nombra equipos.
# Sin usuario en gtd.passwd, el panel no puede autenticar y la regla no aplica.
if [ "$MODO_OP" = "revoke" ]; then
  log "Baja de credencial"
  [ -f "$PASSWD_FILE" ] || die "No existe $PASSWD_FILE."
  if mosquitto_passwd -D "$PASSWD_FILE" "$USERNAME" 2>/dev/null; then
    ok "usuario $USERNAME eliminado"
  else
    warn "el usuario $USERNAME no estaba en el archivo (nada que hacer)"
  fi
  if [ "$DO_RELOAD" -eq 1 ]; then
    log "Recargando mosquitto"
    systemctl reload mosquitto 2>/dev/null || systemctl restart mosquitto
    systemctl is-active --quiet mosquitto || die "mosquitto no quedó activo."
    ok "activo"
  else
    ok "reload omitido (--no-reload): recordá recargar al final del lote"
  fi
  exit 0
fi
```

- [ ] **Step 3: Hacer condicionales el reload y la prueba**

Envolver el bloque `log "Recargando mosquitto"` … `ok "activo"` (línea ~129) en:

```bash
if [ "$DO_RELOAD" -eq 1 ]; then
  ... (el bloque actual, sin cambios)
else
  ok "reload omitido (--no-reload)"
fi
```

Y envolver el bloque `log "Probando la credencial contra 8883"` … hasta el final del `if/else` del `mosquitto_pub`, en:

```bash
# La prueba publica un `status` REAL en el broker. Con un equipo suelto es una
# verificación; con una tanda, el GtD recibiría un status por equipo y marcaría
# toda la tanda como conectada, escribiéndoles `first_connection_at` con los
# paneles todavía en la caja. Por eso el provisioner la apaga y verifica una
# sola vez, al final.
if [ "$DO_PROBE" -eq 1 ]; then
  ... (el bloque actual, sin cambios)
else
  ok "verificación omitida (--no-probe)"
fi
```

- [ ] **Step 4: Verificar la sintaxis y el uso sin privilegios**

```bash
cd /c/Programas_drive/gateway-to-device
bash -n deploy/provision-panel.sh && echo "SINTAXIS OK"
bash deploy/provision-panel.sh 2>&1 | head -2
bash deploy/provision-panel.sh revoke 2>&1 | head -2
```

Expected: `SINTAXIS OK`; las dos invocaciones mueren con `Correr con sudo.` (el chequeo de root es lo primero) — eso confirma que el parseo no rompió el camino de siempre.

- [ ] **Step 5: Commit**

```bash
cd /c/Programas_drive/gateway-to-device
git add deploy/provision-panel.sh
git commit -m "provision-panel: revoke, --no-reload y --no-probe para el uso en lote"
```

---

## Task 5: El provisioner — la capa de base

**Files:**
- Create: `gateway-to-device/src/gtd/provisioner/__init__.py`, `cola.py`
- Test: `gateway-to-device/tests/test_provisioner.py`

**Interfaces:**
- Consumes: `gtd.fetch_pending_provisioning()`, `gtd.confirm_provisioning(BIGINT, TEXT, TEXT)` (Task 1)
- Produces: `Pendiente(id, mac, op)`, `Cola.pendientes()`, `Cola.confirmar(id, res, det)`, `ColaStub`

- [ ] **Step 1: Escribir el test que falla**

Crear `gateway-to-device/tests/test_provisioner.py`:

```python
"""Provisioner: drena la cola, invoca el script y confirma.

Sin base ni broker: la cola y el registrador se sustituyen por dobles. Lo que se
prueba es la POLÍTICA — el orden, el reload único, y que un fallo no arrastre al
resto de la tanda.
"""

import pytest

from gtd.provisioner.cola import ColaStub, Pendiente


async def test_la_cola_stub_devuelve_lo_que_se_le_carga():
    cola = ColaStub([Pendiente(1, "AABBCCDDEE01", "provision")])
    assert await cola.pendientes() == [Pendiente(1, "AABBCCDDEE01", "provision")]


async def test_confirmar_saca_la_fila_de_pendientes():
    cola = ColaStub([Pendiente(1, "AABBCCDDEE01", "provision")])
    await cola.confirmar(1, "ok", None)
    assert await cola.pendientes() == []
    assert cola.confirmaciones == [(1, "ok", None)]
```

- [ ] **Step 2: Correr y ver que falla**

Run: `cd /c/Programas_drive/gateway-to-device && .venv/Scripts/python.exe -m pytest tests/test_provisioner.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'gtd.provisioner'`

- [ ] **Step 3: Implementar**

Crear `gateway-to-device/src/gtd/provisioner/__init__.py` vacío y `cola.py`:

```python
"""Acceso a `gtd.provisioning_queue`.

El provisioner NO toca la tabla: llama las dos funciones que le dejaron, igual
que el GtD con las suyas. Su rol (`cps_provisioner`) no puede encolar — eso es
de la web — ni ejecutar ninguna función del GtD.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Protocol

log = logging.getLogger("gtd.provisioner.cola")


@dataclass(frozen=True)
class Pendiente:
    id: int
    mac: str
    op: str          # "provision" | "revoke"


class Cola(Protocol):
    async def start(self) -> None: ...
    async def close(self) -> None: ...
    async def pendientes(self) -> list[Pendiente]: ...
    async def confirmar(self, id_: int, res: str, det: str | None) -> None: ...


class ColaStub:
    """Cola de memoria, para test y para correr sin base."""

    def __init__(self, filas: list[Pendiente] | None = None) -> None:
        self._filas = list(filas or [])
        self.confirmaciones: list[tuple[int, str, str | None]] = []

    async def start(self) -> None:
        log.warning("ColaStub activa (sin Postgres): nada se persiste.")

    async def close(self) -> None:
        pass

    async def pendientes(self) -> list[Pendiente]:
        return list(self._filas)

    async def confirmar(self, id_: int, res: str, det: str | None) -> None:
        self._filas = [f for f in self._filas if f.id != id_]
        self.confirmaciones.append((id_, res, det))


class ColaPg:
    """Contra Postgres, con asyncpg."""

    _SQL_FETCH = "SELECT id, mac, op FROM gtd.fetch_pending_provisioning()"
    _SQL_CONFIRM = (
        "SELECT gtd.confirm_provisioning(p_id => $1, p_res => $2, p_det => $3)"
    )

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._pool: Any = None

    async def start(self) -> None:
        import asyncpg

        self._pool = await asyncpg.create_pool(self._dsn, min_size=1, max_size=2)
        log.info("ColaPg conectada")

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    async def pendientes(self) -> list[Pendiente]:
        async with self._pool.acquire() as conn:
            filas = await conn.fetch(self._SQL_FETCH)
        return [Pendiente(f["id"], f["mac"], f["op"]) for f in filas]

    async def confirmar(self, id_: int, res: str, det: str | None) -> None:
        async with self._pool.acquire() as conn:
            r = await conn.fetchval(self._SQL_CONFIRM, id_, res, det)
        if r != "ok":
            log.warning("confirm_provisioning id=%s → %s", id_, r)
```

- [ ] **Step 4: Correr y ver que pasa**

Run: `cd /c/Programas_drive/gateway-to-device && .venv/Scripts/python.exe -m pytest tests/test_provisioner.py -q`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/gtd/provisioner/ tests/test_provisioner.py
git commit -m "Provisioner: la capa de cola contra las funciones de gtd"
```

---

## Task 6: El provisioner — registrar en el broker

**Files:**
- Create: `gateway-to-device/src/gtd/provisioner/broker.py`
- Test: `gateway-to-device/tests/test_provisioner.py` (se amplía)

**Interfaces:**
- Consumes: `Pendiente` (Task 5), `deploy/provision-panel.sh` (Task 4)
- Produces: `Registrador.aplicar(p: Pendiente) -> tuple[str, str | None]`, `Registrador.recargar()`, `RegistradorFalso`

- [ ] **Step 1: Escribir el test que falla**

Agregar a `gateway-to-device/tests/test_provisioner.py`:

```python
from gtd.provisioner.broker import RegistradorFalso


async def test_el_registrador_falso_arma_los_argumentos_del_script():
    reg = RegistradorFalso()
    res, det = await reg.aplicar(Pendiente(1, "AABBCCDDEE01", "provision"))
    assert res == "ok" and det is None
    assert reg.llamadas == [["AABBCCDDEE01", "--no-reload", "--no-probe"]]


async def test_revoke_pasa_el_subcomando_primero():
    reg = RegistradorFalso()
    await reg.aplicar(Pendiente(2, "AABBCCDDEE02", "revoke"))
    assert reg.llamadas == [["revoke", "AABBCCDDEE02", "--no-reload"]]


async def test_un_fallo_devuelve_error_con_el_detalle():
    reg = RegistradorFalso(falla_en={"AABBCCDDEE03"})
    res, det = await reg.aplicar(Pendiente(3, "AABBCCDDEE03", "provision"))
    assert res == "error"
    assert det and "salt" in det.lower()
```

- [ ] **Step 2: Correr y ver que falla**

Run: `.venv/Scripts/python.exe -m pytest tests/test_provisioner.py -q`
Expected: FAIL — `No module named 'gtd.provisioner.broker'`

- [ ] **Step 3: Implementar**

Crear `gateway-to-device/src/gtd/provisioner/broker.py`:

```python
"""Registro de la credencial en Mosquitto.

NO reimplementa la derivación HMAC: invoca `deploy/provision-panel.sh`, que ya
la hace bien (bytes crudos de la MAC, no el string) y —lo más importante—
VALIDA el salt contra un vector de verificación conocido antes de derivar nada.
Con un salt equivocado aborta sin registrar, en vez de cargar credenciales que
fallan recién cuando el panel intenta conectar.

Dos copias del HMAC en dos lenguajes es cómo se desincroniza del firmware, y la
divergencia se manifiesta como "el panel no conecta", que no dice nada.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from .cola import Pendiente

log = logging.getLogger("gtd.provisioner.broker")

# El script tarda: mosquitto_passwd + reload + (a veces) la prueba contra 8883.
TIMEOUT_S = 120


def _argumentos(p: Pendiente, con_reload: bool) -> list[str]:
    """Los argumentos del script para esta operación.

    En lote nunca se recarga por equipo ni se publica la prueba: el reload va una
    vez al final y la prueba ensuciaría `first_connection_at` de toda la tanda.
    """
    if p.op == "revoke":
        args = ["revoke", p.mac]
        if not con_reload:
            args.append("--no-reload")
        return args

    args = [p.mac]
    if not con_reload:
        args.append("--no-reload")
    args.append("--no-probe")
    return args


class Registrador:
    """Invoca el script real. Necesita correr como root."""

    def __init__(self, script: Path, salt: str = "", panel_password: str = "") -> None:
        self._script = script
        self._salt = salt
        self._panel_password = panel_password

    def _entorno(self) -> dict[str, str]:
        import os

        env = dict(os.environ)
        # El salt NUNCA por línea de comandos: quedaría en la lista de procesos.
        if self._salt:
            env["SALT_MQTT"] = self._salt
        if self._panel_password:
            env["PANEL_PASSWORD"] = self._panel_password
        return env

    async def aplicar(self, p: Pendiente) -> tuple[str, str | None]:
        args = _argumentos(p, con_reload=False)
        proc = await asyncio.create_subprocess_exec(
            "bash", str(self._script), *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=self._entorno(),
        )
        try:
            salida, _ = await asyncio.wait_for(proc.communicate(), TIMEOUT_S)
        except asyncio.TimeoutError:
            proc.kill()
            return "error", f"el script no terminó en {TIMEOUT_S}s"

        if proc.returncode == 0:
            return "ok", None

        # Las últimas líneas son las que explican el fallo (el script muere con
        # `die`, que imprime el motivo). El salt jamás sale por acá: el script
        # no lo imprime.
        texto = salida.decode("utf-8", "replace").strip().splitlines()
        return "error", " | ".join(texto[-3:]) if texto else "el script falló"

    async def recargar(self) -> tuple[str, str | None]:
        """Un solo reload por tanda."""
        proc = await asyncio.create_subprocess_exec(
            "systemctl", "reload", "mosquitto",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        salida, _ = await proc.communicate()
        if proc.returncode == 0:
            return "ok", None
        return "error", salida.decode("utf-8", "replace").strip()[:200]


class RegistradorFalso:
    """Doble para test: registra los argumentos y no toca nada."""

    def __init__(self, falla_en: set[str] | None = None) -> None:
        self.llamadas: list[list[str]] = []
        self.recargas = 0
        self._falla_en = falla_en or set()

    async def aplicar(self, p: Pendiente) -> tuple[str, str | None]:
        self.llamadas.append(_argumentos(p, con_reload=False))
        if p.mac in self._falla_en:
            return "error", "El salt NO reproduce el vector de verificación"
        return "ok", None

    async def recargar(self) -> tuple[str, str | None]:
        self.recargas += 1
        return "ok", None
```

- [ ] **Step 4: Correr y ver que pasa**

Run: `.venv/Scripts/python.exe -m pytest tests/test_provisioner.py -q`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/gtd/provisioner/broker.py tests/test_provisioner.py
git commit -m "Provisioner: invoca el script en vez de reimplementar el HMAC"
```

---

## Task 7: El provisioner — el bucle de servicio

**Files:**
- Create: `gateway-to-device/src/gtd/provisioner/__main__.py`, `gateway-to-device/deploy/cps-provisioner.service`
- Modify: `gateway-to-device/src/gtd/settings.py`, `.env.example`
- Test: `gateway-to-device/tests/test_provisioner.py` (se amplía)

**Interfaces:**
- Consumes: `Cola`/`ColaStub` (Task 5), `Registrador`/`RegistradorFalso` (Task 6)
- Produces: `drenar(cola, registrador) -> int`

- [ ] **Step 1: Escribir el test que falla**

Agregar a `gateway-to-device/tests/test_provisioner.py`:

```python
from gtd.provisioner.__main__ import drenar


async def test_drenar_procesa_todo_y_recarga_UNA_vez():
    cola = ColaStub([
        Pendiente(1, "AABBCCDDEE01", "provision"),
        Pendiente(2, "AABBCCDDEE02", "provision"),
        Pendiente(3, "AABBCCDDEE03", "provision"),
    ])
    reg = RegistradorFalso()

    hechos = await drenar(cola, reg)

    assert hechos == 3
    assert len(reg.llamadas) == 3
    # LO IMPORTANTE: un reload por tanda, no uno por equipo.
    assert reg.recargas == 1
    assert [c[1] for c in cola.confirmaciones] == ["ok", "ok", "ok"]


async def test_un_fallo_no_arrastra_al_resto_de_la_tanda():
    cola = ColaStub([
        Pendiente(1, "AABBCCDDEE01", "provision"),
        Pendiente(2, "AABBCCDDEE02", "provision"),
        Pendiente(3, "AABBCCDDEE03", "provision"),
    ])
    reg = RegistradorFalso(falla_en={"AABBCCDDEE02"})

    hechos = await drenar(cola, reg)

    assert hechos == 3
    resultados = {i: r for i, r, _ in cola.confirmaciones}
    assert resultados == {1: "ok", 2: "error", 3: "ok"}
    # Igual se recarga: los que SÍ salieron tienen que quedar activos.
    assert reg.recargas == 1


async def test_sin_pendientes_no_recarga():
    cola = ColaStub([])
    reg = RegistradorFalso()
    assert await drenar(cola, reg) == 0
    assert reg.recargas == 0
```

- [ ] **Step 2: Correr y ver que falla**

Run: `.venv/Scripts/python.exe -m pytest tests/test_provisioner.py -q`
Expected: FAIL — `cannot import name 'drenar'`

- [ ] **Step 3: Implementar el bucle**

Crear `gateway-to-device/src/gtd/provisioner/__main__.py`:

```python
"""Provisioner: da de alta y de baja credenciales de panel en el broker.

    python -m gtd.provisioner

Proceso APARTE del GtD y con privilegios propios. El GtD está encerrado
(`NoNewPrivileges`, `ProtectSystem=strict`) porque recibe payloads de cada panel;
esto necesita escribir /etc/mosquitto y recargar el servicio. Compartimos el
repo —la derivación tiene que coincidir con el firmware— pero no el proceso.

No habla MQTT. Su única entrada son filas de una base local.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from ..obs import logging as obs
from ..settings import Settings
from .broker import Registrador
from .cola import Cola, ColaPg, ColaStub

log = logging.getLogger("gtd.provisioner")

# Cada cuánto se barre aunque no haya llegado un NOTIFY. Un NOTIFY emitido
# mientras esto estaba caído no vuelve nunca (misma lección que P0-1 del GtD).
BARRIDO_S = 60


async def drenar(cola: Cola, registrador) -> int:
    """Procesa todos los pendientes y recarga UNA vez. Devuelve cuántos hizo.

    Un fallo se confirma como `error` y se sigue con el resto: una MAC con
    problemas no puede dejar sin credencial a los otros 199 de la tanda.
    """
    pendientes = await cola.pendientes()
    if not pendientes:
        return 0

    log.info("procesando %d pendiente(s)", len(pendientes))
    for p in pendientes:
        res, det = await registrador.aplicar(p)
        if res != "ok":
            log.error("%s %s falló: %s", p.op, p.mac, det)
        else:
            log.info("%s %s ok", p.op, p.mac)
        await cola.confirmar(p.id, res, det)

    # Se recarga aunque alguno haya fallado: los que sí salieron tienen que
    # quedar activos.
    res, det = await registrador.recargar()
    if res != "ok":
        log.error("el reload de mosquitto falló: %s", det)

    return len(pendientes)


async def run() -> None:
    settings = Settings()
    obs.setup(settings.log_level)

    script = Path(settings.provisioner_script)
    if not script.is_file():
        raise SystemExit(f"No existe el script de provisioning: {script}")

    cola: Cola
    if settings.pg_dsn:
        cola = ColaPg(settings.pg_dsn)
    else:
        log.warning("Sin GTD_PG_DSN: nada que drenar.")
        cola = ColaStub()

    registrador = Registrador(
        script, settings.salt_mqtt, settings.panel_password,
    )

    await cola.start()
    log.info("Provisioner arrancando — barrido cada %ss", BARRIDO_S)
    try:
        while True:
            try:
                await drenar(cola, registrador)
            except Exception as e:                    # noqa: BLE001
                # Un error acá no puede matar el servicio: la cola sigue viva y
                # el próximo barrido lo reintenta.
                log.error("barrido falló: %s", e)
            await asyncio.sleep(BARRIDO_S)
    finally:
        await cola.close()


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        log.info("Provisioner detenido.")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Agregar la configuración**

En `gateway-to-device/src/gtd/settings.py`, agregar a la clase `Settings`:

```python
    # Provisioner (proceso aparte: python -m gtd.provisioner)
    # El SALT vive ACÁ y en ningún otro lado: quien lo tiene puede calcular la
    # credencial de cualquier panel de la flota. La web nunca lo ve.
    salt_mqtt: str = ""
    # Interín para builds de laboratorio: password fija, no necesita el salt.
    panel_password: str = ""
    provisioner_script: str = "deploy/provision-panel.sh"
```

Y en `.env.example`, agregar con su comentario:

```
# ── Provisioner (python -m gtd.provisioner) ─────────────────────────
# Secreto de derivación de credenciales. Se valida contra un vector conocido
# antes de registrar nada. NUNCA va en el .env de la web.
GTD_SALT_MQTT=
# Alternativa para builds de laboratorio (no usa el salt).
GTD_PANEL_PASSWORD=
GTD_PROVISIONER_SCRIPT=deploy/provision-panel.sh
```

- [ ] **Step 5: El systemd unit**

Crear `gateway-to-device/deploy/cps-provisioner.service`:

```ini
[Unit]
Description=CPS Provisioner — alta y baja de credenciales de panel en el broker
Documentation=https://github.com/CPSSecurity27/gateway-to-device
After=network-online.target mosquitto.service postgresql.service
Wants=network-online.target

[Service]
Type=simple
# Corre como root: escribe /etc/mosquitto/gtd.passwd (root:mosquitto 0640) y
# recarga el broker. A diferencia del GtD, NO habla MQTT: su única entrada son
# filas de una base local, y la MAC ya viene validada por el CHECK de la base y
# revalidada por el script.
User=root
WorkingDirectory=/home/servidorcps/SistemaCPS/gateway-to-device
ExecStart=/home/servidorcps/SistemaCPS/gateway-to-device/.venv/bin/python -m gtd.provisioner
Environment=PYTHONUNBUFFERED=1

Restart=always
RestartSec=30

# Endurecimiento hasta donde llega sin romper el trabajo: necesita /etc/mosquitto
# y systemctl, y nada más.
ProtectHome=read-only
ReadWritePaths=/etc/mosquitto
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 6: Correr los tests**

Run: `cd /c/Programas_drive/gateway-to-device && .venv/Scripts/python.exe -m pytest tests/ -q`
Expected: todos pasan, incluidos los 8 del provisioner.

- [ ] **Step 7: Commit**

```bash
git add src/gtd/provisioner/ src/gtd/settings.py .env.example deploy/cps-provisioner.service tests/test_provisioner.py
git commit -m "Provisioner: bucle de servicio con barrido, un reload por tanda y unit propio"
```

---

## Task 8: El bloque de provisioning en la ficha

**Files:**
- Modify: `frontend-angular/src/app/core/models/api.models.ts`, `core/api/devices.service.ts`, `features/devices/device-detail.html`, `device-detail.ts`

**Interfaces:**
- Consumes: `POST /devices/:id/provision`, `POST /devices/:id/revoke-credential`, `DeviceProvisioning.queue` (Task 2)

- [ ] **Step 1: Los tipos**

En `frontend-angular/src/app/core/models/api.models.ts`, agregar al final de la interfaz `DeviceProvisioning` (buscarla por `mqttUsername`):

```ts
  /** La última operación de alta/baja pedida. null si nunca se pidió ninguna. */
  queue: {
    op: 'provision' | 'revoke';
    estado: 'pending' | 'done' | 'failed';
    detalle: string | null;
    createdAt: string;
  } | null;
```

- [ ] **Step 2: Los dos métodos**

En `frontend-angular/src/app/core/api/devices.service.ts`, junto a los de configuración:

```ts
  /** Pedir el alta de la credencial en el broker. Solo CPS. */
  pedirProvision(id: number): Observable<{ mensaje: string }> {
    return this.http.post<{ mensaje: string }>(
      `${this.api}/devices/${id}/provision`, {},
    );
  }

  /** Dar de baja la credencial. Siempre manual, nunca por cambio de estado. */
  revocarCredencial(id: number): Observable<{ mensaje: string }> {
    return this.http.post<{ mensaje: string }>(
      `${this.api}/devices/${id}/revoke-credential`, {},
    );
  }
```

- [ ] **Step 3: El componente**

En `frontend-angular/src/app/features/devices/device-detail.ts`, agregar:

```ts
  /** Dado de baja pero con credencial viva: nada revoca solo, así que se avisa. */
  protected readonly credencialHuerfana = computed(() => {
    const d = this.device();
    return d?.status === 'RETIRED' && d?.provisioning?.brokerRegistered === true;
  });

  protected readonly provisionando = signal(false);

  protected pedirProvision(): void {
    this.provisionando.set(true);
    this.devices.pedirProvision(this.id).subscribe({
      next: () => this.recargar(),
      error: (e: unknown) => {
        this.error.set(apiErrorMessage(e));
        this.provisionando.set(false);
      },
    });
  }

  protected revocarCredencial(): void {
    if (!confirm('El equipo va a dejar de poder conectarse al broker. ¿Seguro?')) return;
    this.provisionando.set(true);
    this.devices.revocarCredencial(this.id).subscribe({
      next: () => this.recargar(),
      error: (e: unknown) => {
        this.error.set(apiErrorMessage(e));
        this.provisionando.set(false);
      },
    });
  }
```

Si no existe un método `recargar()` que vuelva a pedir el equipo, extraer el bloque de carga del `constructor`/`ngOnInit` a uno y llamarlo desde ahí — evita duplicar la lógica de carga.

- [ ] **Step 4: La plantilla**

En `frontend-angular/src/app/features/devices/device-detail.html`, reemplazar el bloque que hoy muestra `pendingCommand` por:

```html
@if (alarma.provisioning; as prov) {
  <div class="border-top mt-3 pt-3">
    <p class="fw-semibold small mb-2">
      <i class="icon-key me-1"></i> Credencial del broker
    </p>

    @if (credencialHuerfana()) {
      <div class="alert alert-warning small py-2">
        Este equipo está dado de baja pero <strong>conserva su credencial</strong>.
        La baja de credenciales no es automática: hay que revocarla a mano.
      </div>
    }

    @switch (prov.queue?.estado) {
      @case ('pending') {
        <p class="small text-muted mb-2">
          <span class="spinner-border spinner-border-sm me-1"></span>
          {{ prov.queue?.op === 'revoke' ? 'Baja' : 'Alta' }} en cola…
        </p>
      }
      @case ('failed') {
        <div class="alert alert-danger small py-2 mb-2">
          No se pudo {{ prov.queue?.op === 'revoke' ? 'dar de baja' : 'registrar' }}:
          {{ prov.queue?.detalle }}
        </div>
      }
    }

    @if (prov.brokerRegistered) {
      <p class="small mb-2">
        Registrada el {{ prov.provisionedAt | date: 'short' }} ·
        usuario <code>{{ prov.mqttUsername }}</code>
      </p>
      <button type="button" class="btn btn-sm btn-outline-danger"
              [disabled]="provisionando()" (click)="revocarCredencial()">
        Revocar credencial
      </button>
    } @else {
      <p class="small text-muted mb-2">
        Sin registrar: el equipo <strong>no puede conectarse</strong> al broker.
      </p>
      <button type="button" class="btn btn-sm btn-brand"
              [disabled]="provisionando()" (click)="pedirProvision()">
        Registrar en el broker
      </button>
      @if (prov.pendingCommand) {
        <details class="mt-2">
          <summary class="small text-muted">Hacerlo a mano en el servidor</summary>
          <code class="d-block small mt-1">{{ prov.pendingCommand }}</code>
        </details>
      }
    }
  </div>
}
```

- [ ] **Step 5: Regenerar los íconos**

`icon-key` es nuevo y la fuente es un subset generado. Sin esto, el ícono no se dibuja y el test de íconos falla:

```bash
cd frontend-angular && python scripts/generar-iconos.py
```

- [ ] **Step 6: Verificar**

```bash
cd frontend-angular
npx tsc --noEmit -p tsconfig.json && npx ng build && npm test
```

Expected: build limpio y toda la suite en verde (incluido `iconos.spec.ts`).

- [ ] **Step 7: Commit**

```bash
git add frontend-angular/src/
git commit -m "Ficha del equipo: la credencial del broker deja de ser un log y tiene botones"
```

---

## Task 9: Documentación

**Files:**
- Modify: `backend-nestjs/docs/activos.md`, `gateway-to-device/deploy/README.md`, `gateway-to-device/README.md`, `docs/estado-proyecto.md`

- [ ] **Step 1: El backend**

En `backend-nestjs/docs/activos.md`, sección nueva "Credencial del broker": los dos endpoints, quién puede (solo CPS), que el alta de fábrica encola sola, que la baja es siempre manual (con el porqué), y que el `SALT_MQTT` **no vive acá**.

- [ ] **Step 2: Corregir el deploy README del GtD**

`gateway-to-device/deploy/README.md` dice "**Postgres no está instalado** → el GtD corre con `StubRepo`". **Es falso desde al menos el 4/8/2026**: la Raspberry tiene PostgreSQL 17.10 corriendo, escuchando en `127.0.0.1:5432`, con la base `cps_security_monitoring` (esquema v2 congelado en la migración 4 de 16). Lo que sí es cierto es que `GTD_PG_DSN` está vacío, y por eso corre con `StubRepo`.

Corregir ese párrafo y agregar una sección del provisioner: qué es, por qué es un proceso aparte, cómo se instala el unit y que el `SALT_MQTT` va en su entorno.

- [ ] **Step 3: El README del GtD**

Agregar el provisioner al mapa de componentes: `python -m gtd` (el puente) y `python -m gtd.provisioner` (las credenciales), con una línea sobre por qué son dos.

- [ ] **Step 4: Estado del proyecto**

En `docs/estado-proyecto.md`, agregar el punto con lo hecho y lo que queda: el despliegue (que no se hizo), el `SALT_MQTT` de producción (PA4, acción humana), y que la base de producción se va a llamar `cpssecurityarg`.

- [ ] **Step 5: Commit**

```bash
git add backend-nestjs/docs/ docs/ && git commit -m "Docs del provisioner"
cd /c/Programas_drive/gateway-to-device
git add README.md deploy/README.md && git commit -m "Docs: el provisioner, y corregir que Postgres sí está instalado"
```

---

## Self-Review

**Cobertura de la spec:**

| Sección de la spec | Tarea |
|---|---|
| §2 reusar el script | T4 (flags), T6 (lo invoca en vez de reimplementar) |
| §3.1 proceso y ubicación | T5, T6, T7 |
| §3.2 privilegios | T7 (unit propio, GtD intacto) |
| §4.1 tabla | T1 |
| §4.2 las tres funciones | T1 |
| §4.3 rol `cps_provisioner` | T1 (creación y GRANTs) |
| §4.4 NOTIFY + barrido | T1 (trigger), T7 (`BARRIDO_S`) |
| §5 flags del script | T4 |
| §6 alta automática | T2 (Step 2) |
| §6 baja solo por botón | T2 (endpoint), T8 (botón con confirmación) |
| §6 mitigación credencial huérfana | T8 (`credencialHuerfana`) |
| §7 errores | T1 (`confirm` con error no toca `device`), T6 (timeout), T7 (un fallo no arrastra) |
| §8 qué ve el usuario | T8 |
| §9 pruebas | T1 (SQL con roles), T3 (e2e), T5-T7 (provisioner) |
| §10-11 fuera de alcance | Ninguna tarea toca la Raspberry — consta en Global Constraints |

**Consistencia de tipos:** `Pendiente(id, mac, op)` es el mismo en T5, T6 y T7. `drenar(cola, registrador) -> int` se define en T7 y se usa solo ahí. `ProvisioningQueueView` (T2) y el tipo `queue` del front (T8) tienen los mismos cuatro campos. Las firmas SQL coinciden entre T1 (definición), T2 (`enqueue`) y T5 (`fetch`/`confirm`).

**Orden de dependencias:** T1 → T2 → T3. T4 → T6. T5 → T6 → T7. T2 → T8. T9 al final. T4 y T5 pueden ir en paralelo con T2/T3.
