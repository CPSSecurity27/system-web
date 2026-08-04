# Configuración por equipo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un operador pueda configurar una alarma comunitaria desde la web —redes WiFi, módulos, tiempos, auto-off, roaming, mantenimiento— con confirmación real del equipo y sin poder mentirle al usuario.

**Architecture:** Sin tablas de configuración nuevas. `gtd.config_espejo` (lo que el panel corre) es la verdad de lectura; `gtd.publish_config` es el único camino de escritura. Se agregan dos funciones SQL (`confirm_config`, `last_scan`), cinco endpoints en `DevicesController` y una tercera pestaña en la ficha del equipo.

**Tech Stack:** PostgreSQL 18 (PL/pgSQL, esquema `gtd`) · NestJS + TypeORM · Angular 21 (signals, standalone) · Jest · Playwright vía la skill `webapp-testing`.

## Global Constraints

- **Diseño de referencia:** `docs/superpowers/specs/2026-08-04-configuracion-por-equipo-design.md`. Ante duda, manda la spec.
- **Idioma:** español rioplatense (voseo) en docs, comentarios, mensajes de error y textos de UI.
- **El SQL manda:** migraciones **a mano**, nunca `migration:generate` (no existe, es a propósito). Toda columna/función va en la migración *y* en la entidad, a mano, en los dos lados. Ver `backend-nestjs/docs/migraciones.md`.
- **Numeración de migraciones:** la última aplicada es `1786400000000-GtdBridgeFunctions`. Las nuevas arrancan en `1786500000000`.
- **Permisos:** el rol dice QUÉ, la membresía/alcance dice DÓNDE. **Todo endpoint con `:id` valida alcance además de rol.** Checklist en `backend-nestjs/docs/seguridad.md`.
- **Passwords WiFi:** jamás en un log, jamás en una respuesta que no sea `/config/reveal-wifi`, jamás en un test fixture commiteado con valor realista.
- **Verificación backend:** `npx tsc --noEmit && npx eslint "src/**/*.ts" && npm test` desde `backend-nestjs/`.
- **Verificación frontend:** `npm test` desde `frontend-angular/`.
- **Base local:** `cps_security_v2`, admin `postgres`/`root`, app `cps_web`/`CpsWeb2026!`, alarmas `cps_alarms`/`CpsAlarms2026!`. `psql` en `C:\Program Files\PostgreSQL\18\bin\psql.exe`; **siempre** `$env:PGPASSWORD` antes de invocarlo o se cuelga pidiendo la clave.
- **Commits:** sin `Co-Authored-By`, sin firmas de IA.

---

## File Structure

**Se crean:**

| Archivo | Responsabilidad |
|---|---|
| `backend-nestjs/src/database/migrations/1786500000000-GtdConfigFunctions.ts` | `gtd.confirm_config` + `gtd.last_scan` + sus GRANTs |
| `backend-nestjs/src/devices/device-config.service.ts` | Toda la lógica de configuración: leer espejo, validar patch, publicar, scan, reveal |
| `backend-nestjs/src/devices/dto/device-config.dto.ts` | DTOs de entrada y las vistas de salida |
| `backend-nestjs/src/devices/device-config.limits.ts` | Los límites del firmware en un solo lugar, con su fuente citada |
| `backend-nestjs/test/device-config.e2e-spec.ts` | Integración de los 5 endpoints contra la base real |
| `backend-nestjs/src/devices/device-config.limits.spec.ts` | Unitarios de validación (bordes) |
| `frontend-angular/src/app/features/devices/device-config.ts` | Componente de la pestaña |
| `frontend-angular/src/app/features/devices/device-config.html` | Su plantilla |
| `frontend-angular/src/app/features/devices/device-config.spec.ts` | Tests del componente |

**Se modifican:**

| Archivo | Cambio |
|---|---|
| `backend-nestjs/src/devices/devices.controller.ts` | 5 endpoints nuevos |
| `backend-nestjs/src/devices/devices.module.ts` | Registrar `DeviceConfigService` |
| `backend-nestjs/docs/migraciones.md` | Fila de la migración nueva |
| `backend-nestjs/docs/activos.md` | Sección de configuración |
| `docs/esquema-postgres-v2.sql` | §13: las dos funciones nuevas |
| `docs/roles-conexion-v2.sql` | GRANTs de las dos funciones |
| `docs/contrato-gtd-postgres.md` | `confirm_config` en el contrato |
| `docs/gtd-guia-implementacion.md` | Que el ack de `cfg` va por `confirm_config` |
| `frontend-angular/src/app/core/models/api.models.ts` | Tipos de configuración |
| `frontend-angular/src/app/core/services/devices.service.ts` | 5 métodos nuevos |
| `frontend-angular/src/app/features/devices/device-detail.html` | Tercera pestaña |
| `frontend-angular/src/app/features/devices/device-detail.ts` | Cableado de la pestaña |
| `gateway-to-device/src/gtd/pipeline/uplink.py` | Ack de `cfg` → `confirm_config` |
| `gateway-to-device/src/gtd/db/repo.py` | `confirm_config` en el Protocol + Stub + PgRepo |
| `gateway-to-device/tests/test_uplink_v2.py` | Que el ack de cfg llame `confirm_config` |

---

## Task 1: Las dos funciones SQL

**Files:**
- Create: `backend-nestjs/src/database/migrations/1786500000000-GtdConfigFunctions.ts`
- Modify: `backend-nestjs/docs/migraciones.md`, `docs/roles-conexion-v2.sql`, `docs/esquema-postgres-v2.sql`

**Interfaces:**
- Consumes: `gtd.panel_config`, `gtd.config_espejo`, `gtd.uplink_raw`, `gtd.commands` (del plan 1)
- Produces: `gtd.confirm_config(TEXT, BIGINT, TEXT, TEXT) RETURNS TEXT` y `gtd.last_scan(INT) RETURNS TABLE (redes JSONB, received_at TIMESTAMPTZ)`

- [ ] **Step 1: Escribir la migración**

Crear `backend-nestjs/src/database/migrations/1786500000000-GtdConfigFunctions.ts`:

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Configuración por equipo — las dos funciones que faltaban (2026-08-04).
 *
 * Ver `docs/superpowers/specs/2026-08-04-configuracion-por-equipo-design.md`.
 *
 * 1. `confirm_config` — el ack de una `cfg` no trae `cid`, así que hoy el GtD lo
 *    manda por `insert_evento` y termina en el dead letter como `sin_destino`:
 *    la confirmación existe y la estamos tirando.
 *
 *    Además encola sola el `cmd t:refresh`. Hace falta porque aplicar una `cfg`
 *    NO refresca el espejo de forma confiable: `app_roam_set`,
 *    `app_autooff_set_mode` y `app_mante_set` llaman a `cfg_full_touch()` por
 *    dentro, pero `tiempos` usa `eeprom_nvs_mqtt_set_tele_s` directo y no. El
 *    espejo se actualiza a veces, según qué secciones tocó el patch.
 *
 *    El encadenado vive acá y no en Python por lo mismo que todo el contrato: un
 *    cambio de mapeo es una migración nuestra, no un deploy de ellos.
 *
 * 2. `last_scan` — los scans YA se guardan en `gtd.uplink_raw` (todo lo que no es
 *    `alarma` cae ahí con el payload completo). La función existe para que la
 *    intención quede explícita y para poder cambiar el almacenamiento después
 *    sin tocar la web.
 */
export class GtdConfigFunctions1786500000000 implements MigrationInterface {
  name = 'GtdConfigFunctions1786500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION gtd.confirm_config(
        p_mac   TEXT,
        p_cfg_v BIGINT,
        p_res   TEXT DEFAULT 'ok',
        p_det   TEXT DEFAULT NULL
      ) RETURNS TEXT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_device_id INT;
        v_cid       TEXT;
      BEGIN
        SELECT id INTO v_device_id FROM device WHERE mac = p_mac;
        IF v_device_id IS NULL THEN
          INSERT INTO gtd.uplink_raw (mac, tipo, payload, resultado)
          VALUES (p_mac, 'ack_cfg',
                  jsonb_build_object('cfg_v', p_cfg_v, 'res', p_res, 'det', p_det),
                  'unknown_device');
          RETURN 'unknown_device';
        END IF;

        -- El firmware tiene el res hardcodeado en 'ok' y no existe ack de error
        -- para cfg, pero se respeta el parámetro: el día que lo agreguen, esto ya
        -- lo distingue sin tocar nada.
        IF p_res IS DISTINCT FROM 'ok' THEN
          UPDATE gtd.panel_config
             SET estado = 'failed', detalle = COALESCE(p_det, 'el panel rechazó la cfg'),
                 updated_at = now()
           WHERE mac = p_mac AND cfg_v = p_cfg_v;
          RETURN CASE WHEN FOUND THEN 'ok' ELSE 'noop' END;
        END IF;

        UPDATE gtd.panel_config
           SET estado = 'applied', detalle = NULL, updated_at = now()
         WHERE mac = p_mac AND cfg_v = p_cfg_v AND estado <> 'applied';

        IF NOT FOUND THEN
          RETURN 'noop';
        END IF;

        -- El refresh que trae el espejo de vuelta. Encadenado al ack y NO
        -- disparado junto con la cfg: van por tópicos distintos y un refresh que
        -- gane la carrera refrescaría la configuración vieja.
        v_cid := 'refresh-' || p_mac || '-' || p_cfg_v;
        INSERT INTO gtd.commands (cid, mac, device_id, tipo, payload, estado)
        VALUES (v_cid, p_mac, v_device_id, 'refresh',
                jsonb_build_object('t', 'refresh', 'cid', v_cid), 'pending')
        ON CONFLICT (cid) DO NOTHING;

        RETURN 'ok';
      END;
      $fn$
    `);

    await queryRunner.query(`
      CREATE FUNCTION gtd.last_scan(p_device_id INT)
      RETURNS TABLE (redes JSONB, received_at TIMESTAMPTZ)
      LANGUAGE sql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
        SELECT COALESCE(u.payload->'redes', '[]'::JSONB), u.received_at
          FROM gtd.uplink_raw u
          JOIN device d ON d.mac = u.mac
         WHERE d.id = p_device_id AND u.tipo = 'scan'
         ORDER BY u.received_at DESC
         LIMIT 1;
      $fn$
    `);

    // Postgres le da EXECUTE a PUBLIC en toda función nueva: sin este REVOKE,
    // revocarle a un rol puntual no sirve de nada.
    await queryRunner.query(`
      REVOKE EXECUTE ON FUNCTION
        gtd.confirm_config(TEXT, BIGINT, TEXT, TEXT),
        gtd.last_scan(INT)
      FROM PUBLIC
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_alarms') THEN
          GRANT EXECUTE ON FUNCTION
            gtd.confirm_config(TEXT, BIGINT, TEXT, TEXT) TO cps_alarms;
        END IF;
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_web') THEN
          GRANT EXECUTE ON FUNCTION gtd.last_scan(INT) TO cps_web;
        END IF;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION IF EXISTS gtd.last_scan(INT)`);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS gtd.confirm_config(TEXT, BIGINT, TEXT, TEXT)`,
    );
  }
}
```

- [ ] **Step 2: Aplicar y verificar up → down → up**

```powershell
cd backend-nestjs
npm run migration:run
npm run migration:revert
npm run migration:run
```

Esperado: las tres corren sin error. `revert` deshace solo esta migración.

- [ ] **Step 3: Probar las funciones con el rol real**

```powershell
$env:PGPASSWORD="CpsAlarms2026!"
$psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"

# Equipo inexistente: devuelve unknown_device y NO explota
& $psql -U cps_alarms -h localhost -d cps_security_v2 -c "SELECT gtd.confirm_config('FFFFFFFFFFFF', 1)"

# cps_alarms NO puede leer el scan (es de la web)
& $psql -U cps_alarms -h localhost -d cps_security_v2 -c "SELECT * FROM gtd.last_scan(1)"
```

Esperado: la primera devuelve `unknown_device`; la segunda falla con **permiso denegado**. Ese error es el resultado correcto.

- [ ] **Step 4: Documentar**

En `backend-nestjs/docs/migraciones.md`, agregar la fila:

```markdown
| `1786500000000-GtdConfigFunctions` | Configuración por equipo: `gtd.confirm_config` (el ack de `cfg` deja de caer en el dead letter y encola solo el `cmd t:refresh` que trae el espejo de vuelta) y `gtd.last_scan` (último `up t:scan` del equipo, leído de `uplink_raw` sin tabla nueva) |
```

En `docs/roles-conexion-v2.sql`, sumar `gtd.confirm_config(TEXT, BIGINT, TEXT, TEXT)` al bloque de `cps_alarms` y `gtd.last_scan(INT)` al de `cps_web`.

En `docs/esquema-postgres-v2.sql` §13, transcribir las dos funciones.

- [ ] **Step 5: Commit**

```bash
git add backend-nestjs/src/database/migrations/1786500000000-GtdConfigFunctions.ts backend-nestjs/docs/migraciones.md docs/roles-conexion-v2.sql docs/esquema-postgres-v2.sql
git commit -m "Configuración por equipo: confirm_config cierra el ack de cfg y last_scan lee el último scan"
```

---

## Task 2: Los límites del firmware, en un solo lugar

**Files:**
- Create: `backend-nestjs/src/devices/device-config.limits.ts`
- Test: `backend-nestjs/src/devices/device-config.limits.spec.ts`

**Interfaces:**
- Produces: `LIMITES`, `validarPatch(patch: Record<string, unknown>): string[]`, `MAX_PAYLOAD_BYTES`

- [ ] **Step 1: Escribir el test que falla**

Crear `backend-nestjs/src/devices/device-config.limits.spec.ts`:

```ts
import { validarPatch, MAX_PAYLOAD_BYTES } from './device-config.limits';

describe('validarPatch', () => {
  it('acepta un patch vacío', () => {
    expect(validarPatch({})).toEqual([]);
  });

  it('acepta send_tele_s en los bordes', () => {
    expect(validarPatch({ tiempos: { send_tele_s: 30 } })).toEqual([]);
    expect(validarPatch({ tiempos: { send_tele_s: 86400 } })).toEqual([]);
  });

  it('rechaza send_tele_s por debajo del mínimo, diciendo el efectivo', () => {
    const errores = validarPatch({ tiempos: { send_tele_s: 29 } });
    expect(errores).toHaveLength(1);
    expect(errores[0]).toContain('30');
  });

  it('rechaza send_tele_s por encima del máximo', () => {
    expect(validarPatch({ tiempos: { send_tele_s: 86401 } })).toHaveLength(1);
  });

  it('acepta hasta 5 redes y rechaza la sexta', () => {
    const red = { ssid: 'x', psw: 'y' };
    expect(validarPatch({ redes: Array(5).fill(red) })).toEqual([]);
    expect(validarPatch({ redes: Array(6).fill(red) })).toHaveLength(1);
  });

  it('valida los bordes del roaming', () => {
    expect(validarPatch({ red_avanzada: { roam_rssi: -90 } })).toEqual([]);
    expect(validarPatch({ red_avanzada: { roam_rssi: -50 } })).toEqual([]);
    expect(validarPatch({ red_avanzada: { roam_rssi: -91 } })).toHaveLength(1);
    expect(validarPatch({ red_avanzada: { roam_rssi: -49 } })).toHaveLength(1);
    expect(validarPatch({ red_avanzada: { roam_delta: 4 } })).toHaveLength(1);
    expect(validarPatch({ red_avanzada: { roam_delta: 31 } })).toHaveLength(1);
    expect(validarPatch({ red_avanzada: { roam_cooldown_s: 59 } })).toHaveLength(1);
    expect(validarPatch({ red_avanzada: { roam_cooldown_s: 3601 } })).toHaveLength(1);
  });

  it('acumula todos los errores, no corta en el primero', () => {
    const errores = validarPatch({
      tiempos: { send_tele_s: 1 },
      red_avanzada: { roam_delta: 99 },
    });
    expect(errores).toHaveLength(2);
  });

  it('rechaza una red sin ssid', () => {
    expect(validarPatch({ redes: [{ psw: 'sinSsid' }] })).toHaveLength(1);
  });

  it('el límite de payload es el del firmware', () => {
    expect(MAX_PAYLOAD_BYTES).toBe(1024);
  });
});
```

- [ ] **Step 2: Correr y ver que falla**

Run: `cd backend-nestjs && npx jest src/devices/device-config.limits.spec.ts`
Expected: FAIL — `Cannot find module './device-config.limits'`

- [ ] **Step 3: Implementar**

Crear `backend-nestjs/src/devices/device-config.limits.ts`:

```ts
/**
 * Los límites que el FIRMWARE impone, en un solo lugar y con su fuente.
 *
 * Se validan de nuestro lado aunque el firmware clampe, porque el firmware
 * clampa EN SILENCIO y ackea 'ok': sin esto, el usuario pide 5 s de telemetría,
 * la pantalla dice "aplicado" y el equipo quedó en 30.
 *
 * Si el firmware cambia un límite, se cambia acá y el test falla hasta
 * reconciliar.
 */

/** `WIFI_MAX_PROFILES` en `wifi_types.h`. */
export const MAX_REDES = 5;

/** `MQTT_IN_PAYLOAD_MAX`: el buffer de entrada del panel. */
export const MAX_PAYLOAD_BYTES = 1024;

export const LIMITES = {
  /** `app_tele_period_set` en `task_mqtt.c`. */
  send_tele_s: { min: 30, max: 86400 },
  /** Los tres, de `app_roam_set` en `task_wifi.c`. */
  roam_rssi: { min: -90, max: -50 },
  roam_delta: { min: 5, max: 30 },
  roam_cooldown_s: { min: 60, max: 3600 },
} as const;

function rango(
  valor: unknown,
  limite: { min: number; max: number },
  campo: string,
  errores: string[],
): void {
  if (valor === undefined || valor === null) return;
  if (typeof valor !== 'number' || !Number.isFinite(valor)) {
    errores.push(`${campo} tiene que ser un número`);
    return;
  }
  if (valor < limite.min || valor > limite.max) {
    errores.push(
      `${campo}: ${valor} está fuera de rango (${limite.min} a ${limite.max})`,
    );
  }
}

/** Devuelve TODOS los errores, no corta en el primero: el usuario los arregla de una. */
export function validarPatch(patch: Record<string, any>): string[] {
  const errores: string[] = [];

  const redes = patch.redes;
  if (Array.isArray(redes)) {
    if (redes.length > MAX_REDES) {
      errores.push(
        `El equipo guarda hasta ${MAX_REDES} redes y mandaste ${redes.length}`,
      );
    }
    redes.forEach((r, i) => {
      if (!r?.ssid) errores.push(`La red ${i + 1} no tiene SSID`);
    });
  }

  rango(patch.tiempos?.send_tele_s, LIMITES.send_tele_s, 'send_tele_s', errores);

  const ra = patch.red_avanzada;
  if (ra) {
    rango(ra.roam_rssi, LIMITES.roam_rssi, 'roam_rssi', errores);
    rango(ra.roam_delta, LIMITES.roam_delta, 'roam_delta', errores);
    rango(ra.roam_cooldown_s, LIMITES.roam_cooldown_s, 'roam_cooldown_s', errores);
  }

  return errores;
}
```

- [ ] **Step 4: Correr y ver que pasa**

Run: `cd backend-nestjs && npx jest src/devices/device-config.limits.spec.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add backend-nestjs/src/devices/device-config.limits.ts backend-nestjs/src/devices/device-config.limits.spec.ts
git commit -m "Límites del firmware para la configuración, validados de nuestro lado"
```

---

## Task 3: DTOs y vistas

**Files:**
- Create: `backend-nestjs/src/devices/dto/device-config.dto.ts`

**Interfaces:**
- Consumes: `MAX_REDES` de la Task 2
- Produces: `PublishConfigDto`, `DeviceConfigView`, `RedWifiView`, `ScanView`

- [ ] **Step 1: Escribir los DTOs**

Crear `backend-nestjs/src/devices/dto/device-config.dto.ts`:

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';

/**
 * El patch que se publica. Es un JSONB libre a propósito: las secciones válidas
 * las define el firmware y el merge lo hace `gtd.publish_config` contra el
 * espejo. Los rangos los valida `validarPatch` (device-config.limits.ts).
 */
export class PublishConfigDto {
  @ApiProperty({
    description:
      'Patch de configuración. Solo las secciones que cambian; el resto se toma del espejo.',
    example: { tiempos: { send_tele_s: 300 }, modulos: { rf: true } },
  })
  @IsObject()
  patch!: Record<string, unknown>;
}

/** Una red, SIN la password: el GET nunca la devuelve. */
export interface RedWifiView {
  ssid: string;
  prio: number;
  /** Que exista una guardada, no cuál es. */
  tienePassword: boolean;
}

export interface ScanRedView {
  ssid: string;
  rssi: number;
  seg: boolean;
  ch: number;
  /** El panel ya la tiene en sus credenciales. */
  guardada: boolean;
}

export interface ScanView {
  redes: ScanRedView[];
  recibidoEn: string;
}

/** Estado de la publicación, derivado — no hay columna que lo guarde. */
export type EstadoConfig =
  | 'SIN_ESPEJO'
  | 'VERIFICADO'
  | 'PENDIENTE'
  | 'ENVIADA'
  | 'APLICADA_SIN_VERIFICAR'
  | 'FALLIDA';

export interface DeviceConfigView {
  deviceId: number;
  estado: EstadoConfig;
  /** El espejo, sin passwords. null si el equipo nunca reportó. */
  configuracion: Record<string, unknown> | null;
  redes: RedWifiView[];
  /** cfg_v del espejo (lo que corre) y de la cola (lo que le mandamos). */
  cfgVEspejo: string | null;
  cfgVPendiente: string | null;
  /** Por qué no se pudo entregar, cuando estado = FALLIDA. */
  detalle: string | null;
  espejoActualizadoEn: string | null;
  ultimoScan: ScanView | null;
  /** Si este usuario puede editar (gestiona el barrio). */
  puedeEditar: boolean;
}
```

- [ ] **Step 2: Verificar que compila**

Run: `cd backend-nestjs && npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 3: Commit**

```bash
git add backend-nestjs/src/devices/dto/device-config.dto.ts
git commit -m "DTOs de configuración por equipo: el GET nunca devuelve passwords"
```

---

## Task 4: El servicio de configuración

**Files:**
- Create: `backend-nestjs/src/devices/device-config.service.ts`
- Modify: `backend-nestjs/src/devices/devices.module.ts`

**Interfaces:**
- Consumes: `validarPatch`/`MAX_PAYLOAD_BYTES` (Task 2), los DTOs (Task 3), `gtd.publish_config`/`gtd.enqueue_command`/`gtd.last_scan` (SQL), `ScopeService.assertNeighborhood` y `assertManagesNeighborhood`, `AuditService`
- Produces: `DeviceConfigService` con `findConfig`, `publish`, `pedirScan`, `pedirRefresh`, `revelarWifi`

- [ ] **Step 1: Escribir el servicio**

Crear `backend-nestjs/src/devices/device-config.service.ts`:

```ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AccessScope, ScopeService } from '../common/scope.service';
import { AuditService } from '../audit/audit.service';
import { DevicesService } from './devices.service';
import { MAX_PAYLOAD_BYTES, validarPatch } from './device-config.limits';
import {
  DeviceConfigView,
  EstadoConfig,
  RedWifiView,
  ScanView,
} from './dto/device-config.dto';

/**
 * Configuración de un equipo.
 *
 * No hay tabla de configuración: `gtd.config_espejo` (lo que el panel DICE que
 * corre) es la verdad de lectura y `gtd.publish_config` el único camino de
 * escritura. Ver el diseño en
 * `docs/superpowers/specs/2026-08-04-configuracion-por-equipo-design.md`.
 */
@Injectable()
export class DeviceConfigService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly devices: DevicesService,
    private readonly scopes: ScopeService,
    private readonly audit: AuditService,
  ) {}

  /** El equipo, con su barrio validado contra el alcance. Tira 403/404. */
  private async equipoVisible(id: number, scope: AccessScope) {
    const device = await this.devices.findOne(id, scope);
    if (!device.mac) {
      throw new ConflictException(
        'Este equipo no tiene MAC: no se puede configurar hasta que se cargue',
      );
    }
    return device;
  }

  private async puedeEditar(
    neighborhoodId: number | null,
    scope: AccessScope,
  ): Promise<boolean> {
    if (neighborhoodId === null) return false;
    return this.scopes.managesNeighborhood(scope, neighborhoodId);
  }

  /** Saca las passwords del espejo antes de que salga de acá. */
  private redesSinPassword(configuracion: Record<string, any> | null): RedWifiView[] {
    const redes = configuracion?.redes;
    if (!Array.isArray(redes)) return [];
    return redes.map((r: any, i: number) => ({
      ssid: String(r?.ssid ?? ''),
      prio: Number(r?.prio ?? i + 1),
      tienePassword: Boolean(r?.psw),
    }));
  }

  private sinPasswords(
    configuracion: Record<string, any> | null,
  ): Record<string, unknown> | null {
    if (!configuracion) return null;
    const copia = { ...configuracion };
    delete copia.redes; // las redes van aparte, ya saneadas
    return copia;
  }

  async findConfig(id: number, scope: AccessScope): Promise<DeviceConfigView> {
    const device = await this.equipoVisible(id, scope);

    const [espejo] = await this.dataSource.query(
      `SELECT cfg_v, payload, updated_at FROM gtd.config_espejo WHERE device_id = $1`,
      [id],
    );
    const [cola] = await this.dataSource.query(
      `SELECT cfg_v, estado, detalle FROM gtd.panel_config WHERE device_id = $1`,
      [id],
    );
    const [scan] = await this.dataSource.query(
      `SELECT redes, received_at FROM gtd.last_scan($1)`,
      [id],
    );

    const configuracion = espejo?.payload ?? null;

    // El estado es DERIVADO. `verified` no se guarda: sería un segundo lugar
    // donde vive el mismo hecho, libre de contradecir al espejo.
    let estado: EstadoConfig;
    if (!espejo) {
      estado = 'SIN_ESPEJO';
    } else if (!cola) {
      estado = 'VERIFICADO';
    } else if (cola.estado === 'failed') {
      estado = 'FALLIDA';
    } else if (BigInt(espejo.cfg_v) >= BigInt(cola.cfg_v)) {
      estado = 'VERIFICADO';
    } else if (cola.estado === 'applied') {
      estado = 'APLICADA_SIN_VERIFICAR';
    } else if (cola.estado === 'sent') {
      estado = 'ENVIADA';
    } else {
      estado = 'PENDIENTE';
    }

    return {
      deviceId: id,
      estado,
      configuracion: this.sinPasswords(configuracion),
      redes: this.redesSinPassword(configuracion),
      cfgVEspejo: espejo?.cfg_v ?? null,
      cfgVPendiente: cola?.cfg_v ?? null,
      detalle: cola?.detalle ?? null,
      espejoActualizadoEn: espejo?.updated_at ?? null,
      ultimoScan: scan
        ? ({ redes: scan.redes, recibidoEn: scan.received_at } as ScanView)
        : null,
      puedeEditar: await this.puedeEditar(device.neighborhoodId, scope),
    };
  }

  async publish(
    id: number,
    patch: Record<string, unknown>,
    scope: AccessScope,
    userId: number,
  ): Promise<DeviceConfigView> {
    const device = await this.equipoVisible(id, scope);
    if (device.neighborhoodId === null) {
      throw new ConflictException(
        'Este equipo no está instalado en ningún barrio todavía',
      );
    }
    await this.scopes.assertManagesNeighborhood(scope, device.neighborhoodId);

    const errores = validarPatch(patch);
    if (errores.length > 0) throw new BadRequestException(errores);

    let cfgV: string;
    try {
      const [fila] = await this.dataSource.query(
        `SELECT gtd.publish_config($1, $2::jsonb, $3) AS cfg_v`,
        [id, JSON.stringify(patch), userId],
      );
      cfgV = String(fila.cfg_v);
    } catch (e) {
      // publish_config levanta una excepción con un mensaje pensado para el
      // usuario (sin espejo, equipo sin MAC). Se traduce a 409 tal cual: el
      // motor sabe más que nosotros por qué no se puede.
      throw new ConflictException((e as Error).message);
    }

    // El tamaño se mide sobre lo YA mergeado, que es lo que va a viajar. Medirlo
    // sobre el patch no serviría: el merge le suma las secciones completas.
    const [{ bytes }] = await this.dataSource.query(
      `SELECT octet_length(payload::text) AS bytes FROM gtd.panel_config WHERE device_id = $1`,
      [id],
    );
    if (Number(bytes) > MAX_PAYLOAD_BYTES) {
      await this.dataSource.query(`SELECT gtd.cancel_command($1, $2)`, [
        `cfg-${id}-${cfgV}`,
        userId,
      ]);
      throw new BadRequestException(
        `La configuración ocupa ${bytes} bytes y el equipo acepta hasta ${MAX_PAYLOAD_BYTES}. ` +
          'Sacá alguna red WiFi o acortá las contraseñas.',
      );
    }

    await this.audit.record({
      actorUserId: userId,
      action: 'device.config.publish',
      entityType: 'device',
      entityId: id,
      newValue: { cfgV, secciones: Object.keys(patch) },
    });

    return this.findConfig(id, scope);
  }

  private async encolar(
    id: number,
    tipo: 'scan' | 'refresh',
    scope: AccessScope,
    userId: number,
  ): Promise<void> {
    const device = await this.equipoVisible(id, scope);
    if (device.neighborhoodId === null) {
      throw new ConflictException(
        'Este equipo no está instalado en ningún barrio todavía',
      );
    }
    await this.scopes.assertManagesNeighborhood(scope, device.neighborhoodId);

    await this.dataSource.query(
      `SELECT gtd.enqueue_command($1, $2, '{}'::jsonb, $3)`,
      [id, tipo, userId],
    );
  }

  async pedirScan(id: number, scope: AccessScope, userId: number) {
    await this.encolar(id, 'scan', scope, userId);
    return { mensaje: 'Se le pidió al equipo que busque redes. Puede tardar unos segundos.' };
  }

  async pedirRefresh(id: number, scope: AccessScope, userId: number) {
    await this.encolar(id, 'refresh', scope, userId);
    return { mensaje: 'Se le pidió al equipo su configuración actual.' };
  }

  /**
   * Las passwords en claro. SOLO CPS y SIEMPRE auditado: es el único camino de
   * lectura que existe, justamente para que quede registrado quién miró.
   */
  async revelarWifi(
    id: number,
    scope: AccessScope,
    userId: number,
  ): Promise<{ ssid: string; psw: string }[]> {
    await this.equipoVisible(id, scope);

    const [espejo] = await this.dataSource.query(
      `SELECT payload FROM gtd.config_espejo WHERE device_id = $1`,
      [id],
    );
    if (!espejo) {
      throw new ConflictException(
        'El equipo nunca reportó su configuración: no hay contraseñas que mostrar',
      );
    }

    await this.audit.record({
      actorUserId: userId,
      action: 'device.config.reveal_wifi',
      entityType: 'device',
      entityId: id,
    });

    const redes = Array.isArray(espejo.payload?.redes) ? espejo.payload.redes : [];
    return redes.map((r: any) => ({ ssid: String(r?.ssid ?? ''), psw: String(r?.psw ?? '') }));
  }
}
```

- [ ] **Step 2: Registrar en el módulo**

En `backend-nestjs/src/devices/devices.module.ts`, agregar `DeviceConfigService` al array `providers` (y al `exports` si el módulo exporta servicios).

- [ ] **Step 3: Verificar que compila**

Run: `cd backend-nestjs && npx tsc --noEmit`
Expected: sin errores. Si `AuditService.record` tiene otra firma, ajustar las llamadas a la real (leer `src/audit/audit.service.ts` primero).

- [ ] **Step 4: Commit**

```bash
git add backend-nestjs/src/devices/device-config.service.ts backend-nestjs/src/devices/devices.module.ts
git commit -m "Servicio de configuración: el espejo se lee sin passwords y se publica por publish_config"
```

---

## Task 5: Los cinco endpoints

**Files:**
- Modify: `backend-nestjs/src/devices/devices.controller.ts`

**Interfaces:**
- Consumes: `DeviceConfigService` (Task 4), `PublishConfigDto` (Task 3)
- Produces: `GET/PUT /devices/:id/config`, `POST /devices/:id/config/{scan,refresh,reveal-wifi}`

- [ ] **Step 1: Agregar los endpoints**

En `backend-nestjs/src/devices/devices.controller.ts`, después del bloque de `findState` (línea ~143), agregar:

```ts
  /**
   * GET /api/devices/:id/config — la configuración que el equipo DICE que corre.
   * Nunca devuelve passwords: cada red viaja con `tienePassword`.
   */
  @Get(':id/config')
  async findConfig(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeviceConfigView> {
    return this.deviceConfig.findConfig(id, await this.scopes.forUser(user));
  }

  /**
   * PUT /api/devices/:id/config — publica un patch. Lo mergea `gtd.publish_config`
   * contra el espejo: mandar `{"modulos":{"rf":true}}` NO apaga los otros módulos.
   * Solo quien GESTIONA el barrio (con managed_by = CPS, la organización mira).
   */
  @Put(':id/config')
  async publishConfig(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PublishConfigDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeviceConfigView> {
    return this.deviceConfig.publish(
      id,
      dto.patch,
      await this.scopes.forUser(user),
      user.userId,
    );
  }

  /**
   * POST /api/devices/:id/config/scan — que el equipo busque redes.
   * A pedido y nunca automático: el scan interrumpe la máquina de estados del
   * WiFi y, mientras dura, el panel no está siendo una alarma.
   */
  @Post(':id/config/scan')
  async pedirScan(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.deviceConfig.pedirScan(
      id,
      await this.scopes.forUser(user),
      user.userId,
    );
  }

  /** POST /api/devices/:id/config/refresh — pedirle la configuración actual. */
  @Post(':id/config/refresh')
  async pedirRefresh(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.deviceConfig.pedirRefresh(
      id,
      await this.scopes.forUser(user),
      user.userId,
    );
  }

  /** POST /api/devices/:id/config/reveal-wifi — SOLO CPS, siempre auditado. */
  @Post(':id/config/reveal-wifi')
  @RequireMembership({
    accountType: AccountType.COMPANY,
    roles: [UserRole.OWNER, UserRole.ADMIN, UserRole.TECHNICIAN],
  })
  async revelarWifi(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.deviceConfig.revelarWifi(
      id,
      await this.scopes.forUser(user),
      user.userId,
    );
  }
```

Agregar al constructor: `private readonly deviceConfig: DeviceConfigService,`.
Agregar los imports: `Put` desde `@nestjs/common`, `DeviceConfigService`, `PublishConfigDto`, `DeviceConfigView`.

- [ ] **Step 2: Verificar que compila y lintea**

Run: `cd backend-nestjs && npx tsc --noEmit && npx eslint "src/**/*.ts"`
Expected: sin errores.

- [ ] **Step 3: Commit**

```bash
git add backend-nestjs/src/devices/devices.controller.ts
git commit -m "Cinco endpoints de configuración, con alcance validado en cada uno"
```

---

## Task 6: Integración de los endpoints contra la base real

**Files:**
- Create: `backend-nestjs/test/device-config.e2e-spec.ts`

**Interfaces:**
- Consumes: los cinco endpoints (Task 5)

- [ ] **Step 1: Escribir el test**

Crear `backend-nestjs/test/device-config.e2e-spec.ts` con estos casos. Seguir el estilo de los e2e existentes en `backend-nestjs/test/` (leer uno antes de escribir para copiar el arranque de la app y el login).

```ts
/**
 * Configuración por equipo — integración contra la base real.
 *
 * Los casos que importan son los de PERMISO y los de MENTIRA: que un rol que no
 * gestiona no pueda escribir, y que una password no salga nunca por el GET.
 */
describe('Configuración por equipo (e2e)', () => {
  // Fixture: un equipo instalado en un barrio con managed_by = ORGANIZATION,
  // con espejo cargado (payload con una red y su psw) y sin cfg pendiente.

  it('GET devuelve el espejo SIN passwords', async () => {
    // → 200, redes[0].tienePassword === true, y el JSON completo de la respuesta
    //   NO contiene el texto de la password del fixture.
  });

  it('GET sin espejo devuelve estado SIN_ESPEJO', async () => {});

  it('PUT publica y devuelve el estado nuevo', async () => {
    // → 200, estado PENDIENTE, cfgVPendiente > cfgVEspejo
  });

  it('PUT sin espejo devuelve 409 explicando que el equipo nunca reportó', async () => {});

  it('PUT con send_tele_s = 29 devuelve 400 nombrando el mínimo', async () => {});

  it('PUT con 6 redes devuelve 400', async () => {});

  it('PUT que supera 1024 bytes devuelve 400 con el tamaño real', async () => {
    // Fixture: 5 redes con SSID y password largos.
  });

  it('MONITOR no puede publicar (403)', async () => {});

  it('la organización NO puede publicar si managed_by = CPS (403)', async () => {});

  it('la organización SÍ puede publicar si managed_by = ORGANIZATION', async () => {});

  it('reveal-wifi es 403 para la organización y 200 para CPS', async () => {});

  it('reveal-wifi deja una fila en audit_log', async () => {});

  it('PUT sin password en una red existente conserva la del espejo', async () => {
    // Publicar {redes:[{ssid:'X'}]} y verificar en gtd.panel_config que el
    // payload salió con la psw que estaba en el espejo.
  });

  it('scan encola un comando de tipo scan', async () => {});
});
```

Implementar cada caso con el fixture correspondiente. **Las passwords del fixture deben ser obviamente falsas** (`'psw-de-prueba-no-real'`).

- [ ] **Step 2: Correr**

Run: `cd backend-nestjs && npx jest test/device-config.e2e-spec.ts --runInBand`
Expected: los 14 pasan.

- [ ] **Step 3: Commit**

```bash
git add backend-nestjs/test/device-config.e2e-spec.ts
git commit -m "Integración de configuración: permisos por managed_by y que la password nunca salga"
```

---

## Task 7: El GtD manda el ack de `cfg` por `confirm_config`

**Files:**
- Modify: `gateway-to-device/src/gtd/db/repo.py`, `gateway-to-device/src/gtd/pipeline/uplink.py`
- Test: `gateway-to-device/tests/test_uplink_v2.py`

**Interfaces:**
- Consumes: `gtd.confirm_config` (Task 1)
- Produces: `Repo.confirm_config(mac, cfg_v, *, res, det)` en el Protocol, el Stub y `PgRepo`

- [ ] **Step 1: Escribir el test que falla**

En `gateway-to-device/tests/test_uplink_v2.py`, agregar:

```python
async def test_ack_de_cfg_va_por_confirm_config():
    """El ack de una cfg no trae cid: sin esto cae en el dead letter."""
    repo = StubRepo()
    await uplink.handle(
        "av/240AC4000110/up",
        json.dumps({"v": 1, "t": "ack", "cfg_v": 7, "res": "ok",
                    "ts": 1700000000, "tsq": 0}).encode(),
        repo,
    )
    assert repo.configs_confirmadas == [("240AC4000110", 7, "ok", None)]


async def test_ack_de_cmd_sigue_yendo_por_confirm_command():
    repo = StubRepo()
    await uplink.handle(
        "av/240AC4000110/up",
        json.dumps({"v": 1, "t": "ack", "cid": "abc", "res": "ok",
                    "ts": 1700000000, "tsq": 0}).encode(),
        repo,
    )
    assert repo.configs_confirmadas == []
```

- [ ] **Step 2: Correr y ver que falla**

Run: `cd /c/Programas_drive/gateway-to-device && python -m pytest tests/test_uplink_v2.py -k confirm_config -v`
Expected: FAIL — `StubRepo` no tiene `configs_confirmadas`.

- [ ] **Step 3: Implementar**

En `repo.py`, agregar al `Protocol Repo`:

```python
    async def confirm_config(
        self, mac: str, cfg_v: int, *, res: str = "ok", det: str | None = None,
    ) -> None:
        """Ack de una cfg. No trae cid: se correlaciona por (mac, cfg_v)."""
        ...
```

En `StubRepo`, agregar `self.configs_confirmadas: list[tuple] = []` en `__init__` y:

```python
    async def confirm_config(self, mac, cfg_v, *, res="ok", det=None) -> None:
        self.configs_confirmadas.append((mac, cfg_v, res, det))
        log.info("cfg confirmada mac=%s cfg_v=%s res=%s", mac, cfg_v, res)
```

En `PgRepo`, agregar el método siguiendo el patrón de los demás (notación nombrada):

```python
    async def confirm_config(self, mac, cfg_v, *, res="ok", det=None) -> None:
        await self._call(
            "SELECT gtd.confirm_config(p_mac => $1, p_cfg_v => $2, "
            "p_res => $3, p_det => $4)",
            mac, cfg_v, res, det,
        )
```

En `uplink.py`, dentro de `_handle_up`, reemplazar la rama del ack:

```python
    elif t == UpType.ACK.value:
        # Ack de cmd (cid) o de cfg (cfg_v). Son dos caminos distintos: el de cfg
        # no trae cid, así que por insert_evento caería en el dead letter.
        if model.cid:
            await repo.confirm_command(model.cid, res=model.res, det=model.det)
        elif model.cfg_v is not None:
            await repo.confirm_config(device_id, model.cfg_v,
                                      res=model.res or "ok", det=model.det)
        await repo.insert_evento(device_id, t, doc, ts=model.ts)
```

- [ ] **Step 4: Correr y ver que pasa**

Run: `cd /c/Programas_drive/gateway-to-device && python -m pytest tests/ -v`
Expected: todos pasan, incluidos los dos nuevos.

- [ ] **Step 5: Commit**

```bash
cd /c/Programas_drive/gateway-to-device
git add src/gtd/db/repo.py src/gtd/pipeline/uplink.py tests/test_uplink_v2.py
git commit -m "El ack de una cfg va por confirm_config: dejaba de contar por no tener cid"
```

---

## Task 8: Tipos y servicio del frontend

**Files:**
- Modify: `frontend-angular/src/app/core/models/api.models.ts`, `frontend-angular/src/app/core/services/devices.service.ts`

**Interfaces:**
- Produces: `DeviceConfig`, `RedWifi`, `ScanRed`, `EstadoConfig` y los 5 métodos del servicio

- [ ] **Step 1: Agregar los tipos**

En `api.models.ts`, después de `DeviceState`:

```ts
export type EstadoConfig =
  | 'SIN_ESPEJO'
  | 'VERIFICADO'
  | 'PENDIENTE'
  | 'ENVIADA'
  | 'APLICADA_SIN_VERIFICAR'
  | 'FALLIDA';

/** Una red del equipo. La password NUNCA viaja: solo si la tiene. */
export interface RedWifi {
  ssid: string;
  prio: number;
  tienePassword: boolean;
}

export interface ScanRed {
  ssid: string;
  rssi: number;
  seg: boolean;
  ch: number;
  guardada: boolean;
}

export interface DeviceConfig {
  deviceId: number;
  estado: EstadoConfig;
  configuracion: Record<string, unknown> | null;
  redes: RedWifi[];
  /** `bigint` en Postgres, string acá (el driver no los pasa a number). */
  cfgVEspejo: string | null;
  cfgVPendiente: string | null;
  detalle: string | null;
  espejoActualizadoEn: string | null;
  ultimoScan: { redes: ScanRed[]; recibidoEn: string } | null;
  puedeEditar: boolean;
}
```

- [ ] **Step 2: Agregar los métodos del servicio**

En `devices.service.ts`, siguiendo el patrón del método `state(id)` existente:

```ts
  config(id: number): Observable<DeviceConfig> {
    return this.http.get<DeviceConfig>(`${this.base}/${id}/config`);
  }

  publicarConfig(id: number, patch: Record<string, unknown>): Observable<DeviceConfig> {
    return this.http.put<DeviceConfig>(`${this.base}/${id}/config`, { patch });
  }

  pedirScan(id: number): Observable<{ mensaje: string }> {
    return this.http.post<{ mensaje: string }>(`${this.base}/${id}/config/scan`, {});
  }

  pedirRefresh(id: number): Observable<{ mensaje: string }> {
    return this.http.post<{ mensaje: string }>(`${this.base}/${id}/config/refresh`, {});
  }

  revelarWifi(id: number): Observable<{ ssid: string; psw: string }[]> {
    return this.http.post<{ ssid: string; psw: string }[]>(
      `${this.base}/${id}/config/reveal-wifi`, {},
    );
  }
```

- [ ] **Step 3: Verificar**

Run: `cd frontend-angular && npm test`
Expected: verde (sin tests nuevos todavía, pero compila).

- [ ] **Step 4: Commit**

```bash
git add frontend-angular/src/app/core/models/api.models.ts frontend-angular/src/app/core/services/devices.service.ts
git commit -m "Tipos y llamadas de configuración en el front"
```

---

## Task 9: El componente de configuración

**Files:**
- Create: `frontend-angular/src/app/features/devices/device-config.ts`, `device-config.html`
- Test: `frontend-angular/src/app/features/devices/device-config.spec.ts`

**Interfaces:**
- Consumes: `DevicesService` (Task 8), `DeviceConfig`
- Produces: componente standalone `DeviceConfig` con input `deviceId`

- [ ] **Step 1: Escribir los tests**

Crear `device-config.spec.ts` cubriendo:

```ts
describe('DeviceConfig', () => {
  it('con estado SIN_ESPEJO bloquea el formulario y ofrece pedir la configuración', () => {});
  it('con puedeEditar false deshabilita todos los campos', () => {});
  it('muestra el diff de lo que cambia antes de guardar', () => {});
  it('no manda al backend los campos que no cambiaron', () => {});
  it('clic en una red del scan autocompleta el SSID', () => {});
  it('el botón de scan se deshabilita con el panel offline', () => {});
  it('con estado FALLIDA muestra el detalle y ofrece republicar', () => {});
  it('apagar un módulo pide confirmación nombrando la consecuencia', () => {});
});
```

- [ ] **Step 2: Correr y ver que fallan**

Run: `cd frontend-angular && npm test -- --include='**/device-config.spec.ts'`
Expected: FAIL — el componente no existe.

- [ ] **Step 3: Implementar el componente**

Crear `device-config.ts` (standalone, signals, siguiendo el estilo de `device-detail.ts`) con:

- `deviceId` como `input.required<number>()` y `estadoVivo` como `input<DeviceState | null>()` (para saber si está online/durmiendo).
- Signals: `config`, `borrador` (copia editable), `cargando`, `guardando`, `error`.
- `computed` **`cambios`**: compara `borrador` contra `config().configuracion` y devuelve `[{campo, de, a}]`. Es lo que alimenta el diff.
- `computed` **`patch`**: solo las secciones con cambios. **No mandar secciones intactas** — cada byte cuenta contra los 1024.
- `computed` **`puedeEscanear`**: `puedeEditar && estadoVivo?.online === true`.
- `guardar()`: si hay módulos que se apagan, confirmación nombrando la consecuencia; después `publicarConfig`.
- `elegirRedDelScan(ssid)`: completa el SSID en la fila de red que se esté editando y deja el foco en la password.

Crear `device-config.html` con las secciones de la spec §5.1. Los campos de solo lectura (identidad, RF, calibración, firmware) van en un bloque aparte, visualmente distinto, cada uno con su nota de por qué no se edita acá.

**Ojo con Bootstrap:** `[hidden]` no funciona sobre un `.row` (el `display:flex` de autor le gana al `display:none` del user-agent). Usar `d-none`, que lleva `!important`.

- [ ] **Step 4: Correr y ver que pasan**

Run: `cd frontend-angular && npm test -- --include='**/device-config.spec.ts'`
Expected: los 8 pasan.

- [ ] **Step 5: Commit**

```bash
git add frontend-angular/src/app/features/devices/device-config.ts frontend-angular/src/app/features/devices/device-config.html frontend-angular/src/app/features/devices/device-config.spec.ts
git commit -m "Pantalla de configuración: diff antes de guardar y solo se manda lo que cambió"
```

---

## Task 10: Cablear la pestaña en la ficha del equipo

**Files:**
- Modify: `frontend-angular/src/app/features/devices/device-detail.ts`, `device-detail.html`

**Interfaces:**
- Consumes: el componente `DeviceConfig` (Task 9)

- [ ] **Step 1: Agregar la pestaña**

En `device-detail.html`, sumar la tercera pestaña junto a **Ficha** y **Estado en vivo**, con el mismo patrón de las otras dos. Pasarle `[deviceId]="id"` y `[estadoVivo]="state()"`.

En `device-detail.ts`, importar `DeviceConfig` y agregarlo al array `imports`.

- [ ] **Step 2: Verificar en el navegador**

Levantar backend y frontend, y usar la skill `webapp-testing` para comprobar:
1. La pestaña aparece y carga.
2. Un equipo sin espejo muestra el bloqueo y el botón de pedir configuración.
3. Un equipo con espejo muestra las redes con la password enmascarada.
4. El diff aparece al cambiar un valor.

- [ ] **Step 3: Verificación completa**

```powershell
cd backend-nestjs;   npx tsc --noEmit; npx eslint "src/**/*.ts"; npm test
cd ..\frontend-angular; npm test
```

Expected: todo verde.

- [ ] **Step 4: Commit**

```bash
git add frontend-angular/src/app/features/devices/device-detail.ts frontend-angular/src/app/features/devices/device-detail.html
git commit -m "Tercera pestaña en la ficha del equipo: Configuración"
```

---

## Task 11: Documentación y cierre

**Files:**
- Modify: `docs/contrato-gtd-postgres.md`, `docs/gtd-guia-implementacion.md`, `backend-nestjs/docs/activos.md`, `docs/estado-proyecto.md`
- Create: `gateway-to-device/docs/08-propuestas-firmware-cfg.md`

- [ ] **Step 1: Actualizar el contrato**

En `docs/contrato-gtd-postgres.md`, agregar `confirm_config` a las funciones de entrada (pasan a ser 9) y `last_scan` a las de salida. Explicar el encadenado del `refresh` y por qué vive en Postgres.

En `docs/gtd-guia-implementacion.md`, documentar que el ack de `cfg` va por `confirm_config(mac, cfg_v, res, det)` y ya no por `insert_evento`.

- [ ] **Step 2: Documentar la pantalla**

En `backend-nestjs/docs/activos.md`, sección nueva de configuración: los cinco endpoints, la matriz de permisos de la spec §2.2, y los límites del firmware con su fuente.

- [ ] **Step 3: Propuestas al firmware**

Crear `gateway-to-device/docs/08-propuestas-firmware-cfg.md` con las tres de la spec §8, cada una con archivo y línea, el costo de no tenerla y el costo de implementarla. **No se toca el firmware.**

- [ ] **Step 4: Estado del proyecto**

En `docs/estado-proyecto.md`, marcar la configuración por equipo como hecha, con fecha, y anotar lo que queda: campañas masivas, `cmd t:test`, y el cifrado en reposo (DT2, que sigue abierto con la observación del broker).

- [ ] **Step 5: Commit**

```bash
git add docs/ backend-nestjs/docs/
git commit -m "Docs de la configuración por equipo y propuestas al firmware"
```

---

## Self-Review

**Cobertura de la spec:**

| Sección de la spec | Tarea |
|---|---|
| §2.1 config por equipo | Todas (no hay tabla de barrio en ningún lado) |
| §2.2 permisos | T4 (`assertManagesNeighborhood`), T5 (`RequireMembership` en reveal), T6 (matriz) |
| §2.3 enfoque A | T4 (lee espejo, escribe por `publish_config`) |
| §2.4 escalera | T1 (`confirm_config` + refresh), T7 (el GtD lo llama), T4 (estado derivado) |
| §2.5 scan a pedido | T1 (`last_scan`), T5 (endpoint), T9 (botón + autocompletado) |
| §3 funciones SQL | T1 |
| §4 endpoints | T5, con validación en T2 y errores en T4 |
| §5 pantalla | T9, T10 |
| §6 pruebas | T2 (unitarios), T6 (integración), T9 (componente) |
| §8 propuestas firmware | T11 |

**Consistencia de tipos:** `DeviceConfigView` (T3) ↔ `DeviceConfig` (T8) tienen los mismos campos. `EstadoConfig` es el mismo string union en los dos lados. `confirm_config` tiene la misma firma en T1 (SQL), T7 (Python) y la doc de T11.

**Orden de dependencias:** T1 → T4 (las funciones tienen que existir), T2+T3 → T4, T4 → T5 → T6, T8 → T9 → T10. T7 es independiente y puede ir en cualquier momento después de T1.
