import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PasswordService } from '../src/auth/password.service';
import { AccountType, EntityStatus, UserRole } from '../src/common/enums';
import { CLAVE, api, crearApp, login } from './helpers';

/**
 * Configuración por equipo — integración contra la base real.
 *
 * NO usa `sembrar()` de `helpers.ts`: ese arma el modelo v1 (cuentas HOME,
 * `home.name`, serial elegido a mano) y está en rojo desde la migración a v2
 * — es un pendiente conocido y aparte. Acá se siembra lo mínimo del modelo v2,
 * directo por el DataSource: lo que se prueba son los endpoints de
 * configuración, no el onboarding.
 *
 * Los casos que importan son los de PERMISO y los de MENTIRA: que un rol que no
 * gestiona no pueda escribir, y que una password no salga nunca por el GET.
 */

/** Password de fixture. Obviamente falsa a propósito: esto se commitea. */
const PSW_FIXTURE = 'psw-de-prueba-no-real';
const SSID_FIXTURE = 'MuniWiFi';

interface Ids {
  orgA: number;
  barrioOrg: number; // managed_by = ORGANIZATION → la org lo gestiona
  barrioCps: number; // managed_by = CPS → la org solo lo ve
  equipoOrg: number;
  equipoCps: number;
  equipoSinEspejo: number;
}

describe('Configuración por equipo (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let cps: string; // ADMIN de CPS
  let ana: string; // ADMIN de la organización
  let moni: string; // MONITOR de la organización
  let ids: Ids;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function sembrarEspejo(
    deviceId: number,
    cfgV: number,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const payload = {
      cfg_v: cfgV,
      redes: [{ ssid: SSID_FIXTURE, psw: PSW_FIXTURE, prio: 1 }],
      modulos: { ds3231: true, eeprom: true, supervisor: true, rf: true },
      tiempos: { send_tele_s: 300 },
      id: { fw: '6.0.1' },
      ...extra,
    };
    await dataSource.query(
      `INSERT INTO gtd.config_espejo (mac, device_id, cfg_v, payload)
       SELECT mac, id, $2, $3::jsonb FROM device WHERE id = $1
       ON CONFLICT (mac) DO UPDATE SET cfg_v = $2, payload = $3::jsonb`,
      [deviceId, cfgV, JSON.stringify(payload)],
    );
  }

  beforeAll(async () => {
    app = await crearApp();
    dataSource = app.get(DataSource);

    await dataSource.query(`
      TRUNCATE remote_code, remote, device_maintenance, device, service_contract,
               home, neighborhood, account_user, account, user_token,
               refresh_token, app_user, locality, department, province,
               audit_log
      RESTART IDENTITY CASCADE
    `);
    await dataSource.query(
      `TRUNCATE gtd.commands, gtd.panel_config, gtd.config_espejo, gtd.uplink_raw`,
    );

    const hash = await app.get(PasswordService).hash(CLAVE);

    // --- Geografía mínima ---
    const [prov] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO province (georef_id, name) VALUES ('14','Córdoba') RETURNING id`,
    );
    const [dep] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO department (georef_id, name, province_id)
       VALUES ('14014','Capital',$1) RETURNING id`,
      [prov.id],
    );
    const [loc] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO locality (georef_id, name, department_id)
       VALUES ('14014010','Córdoba',$1) RETURNING id`,
      [dep.id],
    );

    // --- CPS (COMPANY, sin cupos ni jurisdicción por el CHECK) ---
    const [cpsAcc] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO account (name, type, status) VALUES ('CPS Security','COMPANY','ACTIVE') RETURNING id`,
    );
    const [cpsUser] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO app_user (name, username, password_hash, status)
       VALUES ('Admin CPS','admin',$1,'ACTIVE') RETURNING id`,
      [hash],
    );
    await dataSource.query(
      `INSERT INTO account_user (account_id, user_id, role)
       VALUES ($1,$2,'ADMIN')`,
      [cpsAcc.id, cpsUser.id],
    );

    // --- Organización: los cinco cupos y las coordenadas son obligatorios ---
    const [orgA] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO account (name, type, subtype, status, jurisdiction_level, locality_id,
                            latitude, longitude, max_neighborhoods, max_admin_users,
                            max_technician_users, max_monitor_users, max_family_members,
                            community_scope_enabled)
       VALUES ('Municipalidad de Córdoba','ORGANIZATION','MUNICIPAL','ACTIVE','LOCALITY',$1,
               -31.42,-64.18, 10, 5, 5, 5, 4, true)
       RETURNING id`,
      [loc.id],
    );

    const usuario = async (
      nombre: string,
      username: string,
      rol: UserRole,
    ): Promise<number> => {
      const [u] = await dataSource.query<{ id: number }[]>(
        `INSERT INTO app_user (name, username, password_hash, status)
         VALUES ($1,$2,$3,'ACTIVE') RETURNING id`,
        [nombre, username, hash],
      );
      await dataSource.query(
        `INSERT INTO account_user (account_id, user_id, role)
         VALUES ($1,$2,$3)`,
        [orgA.id, u.id, rol],
      );
      return u.id;
    };
    await usuario('Ana Admin', 'ana', UserRole.ADMIN);
    await usuario('Moni Monitor', 'moni', UserRole.MONITOR);

    // --- Dos barrios de la MISMA organización, distinto managed_by ---
    const barrio = async (
      nombre: string,
      code: string,
      managedBy: string,
    ): Promise<number> => {
      const [n] = await dataSource.query<{ id: number }[]>(
        `INSERT INTO neighborhood (name, code, locality_id, latitude, longitude,
                                   organization_id, organization_type, managed_by,
                                   max_family_members, community_scope_enabled, status)
         VALUES ($1,$2,$3,-31.42,-64.18,$4,'ORGANIZATION',$5,4,true,'ACTIVE')
         RETURNING id`,
        [nombre, code, loc.id, orgA.id, managedBy],
      );
      return n.id;
    };
    const barrioOrg = await barrio('Barrio Jardín', 'JARDIN', 'ORGANIZATION');
    const barrioCps = await barrio('Barrio Llave', 'LLAVE', 'CPS');

    // --- Equipos: serial DERIVADO de la MAC, con placa (chk_device_identity) ---
    const equipo = async (
      mac: string,
      seq: number,
      neighborhoodId: number,
    ): Promise<number> => {
      const [bm] = await dataSource.query<{ id: number }[]>(
        `INSERT INTO board_model (code, name) VALUES ('ALOY','Aloy')
         ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
      );
      // Sin organization_id: `chk_device_stock_owner` lo reserva para el stock.
      // Instalado, la custodia la da el barrio.
      const [d] = await dataSource.query<{ id: number }[]>(
        `INSERT INTO device (serial, mac, type, status, board_model_id, board_seq,
                             neighborhood_id, latitude, longitude)
         VALUES ($1,$2,'COMMUNITY_ALARM','OPERATIONAL',$3,$4,$5,-31.42,-64.18)
         RETURNING id`,
        ['AV-' + mac, mac, bm.id, seq, neighborhoodId],
      );
      return d.id;
    };

    ids = {
      orgA: orgA.id,
      barrioOrg,
      barrioCps,
      equipoOrg: await equipo('AABBCCDDEE01', 1, barrioOrg),
      equipoCps: await equipo('AABBCCDDEE02', 2, barrioCps),
      equipoSinEspejo: await equipo('AABBCCDDEE03', 3, barrioOrg),
    };

    await sembrarEspejo(ids.equipoOrg, 5);
    await sembrarEspejo(ids.equipoCps, 5);

    cps = await login(app, 'admin');
    ana = await login(app, 'ana');
    moni = await login(app, 'moni');
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Lectura ────────────────────────────────────────────────────────

  it('el GET devuelve el espejo SIN passwords', async () => {
    const res = await api(app)
      .get(`/api/devices/${ids.equipoOrg}/config`)
      .set(auth(ana))
      .expect(200);

    const body = res.body as {
      estado: string;
      redes: { ssid: string; tienePassword: boolean }[];
    };
    expect(body.estado).toBe('VERIFICADO');
    expect(body.redes).toEqual([
      { ssid: SSID_FIXTURE, prio: 1, tienePassword: true },
    ]);
    // Lo que de verdad importa: la password no aparece EN NINGÚN LADO.
    expect(JSON.stringify(res.body)).not.toContain(PSW_FIXTURE);
  });

  it('sin espejo, el estado es SIN_ESPEJO', async () => {
    const res = await api(app)
      .get(`/api/devices/${ids.equipoSinEspejo}/config`)
      .set(auth(ana))
      .expect(200);
    const body = res.body as { estado: string; configuracion: unknown };
    expect(body.estado).toBe('SIN_ESPEJO');
    expect(body.configuracion).toBeNull();
  });

  it('puedeEditar distingue gestionar de solo ver', async () => {
    const gestiona = await api(app)
      .get(`/api/devices/${ids.equipoOrg}/config`)
      .set(auth(ana))
      .expect(200);
    const soloVe = await api(app)
      .get(`/api/devices/${ids.equipoCps}/config`)
      .set(auth(ana))
      .expect(200);

    expect((gestiona.body as { puedeEditar: boolean }).puedeEditar).toBe(true);
    expect((soloVe.body as { puedeEditar: boolean }).puedeEditar).toBe(false);
  });

  // ── Publicación ────────────────────────────────────────────────────

  it('el PUT publica y deja la cfg pendiente con la versión siguiente', async () => {
    const res = await api(app)
      .put(`/api/devices/${ids.equipoOrg}/config`)
      .set(auth(ana))
      .send({ patch: { tiempos: { send_tele_s: 600 } } })
      .expect(200);

    const body = res.body as {
      estado: string;
      cfgVEspejo: string;
      cfgVPendiente: string;
    };
    expect(body.estado).toBe('PENDIENTE');
    expect(Number(body.cfgVPendiente)).toBeGreaterThan(Number(body.cfgVEspejo));
  });

  it('una red sin password conserva la del espejo', async () => {
    await api(app)
      .put(`/api/devices/${ids.equipoOrg}/config`)
      .set(auth(ana))
      .send({ patch: { redes: [{ ssid: SSID_FIXTURE, prio: 1 }] } })
      .expect(200);

    // Se mira la COLA, que es lo que va a viajar al panel.
    const [fila] = await dataSource.query<{ payload: { redes: unknown[] } }[]>(
      `SELECT payload FROM gtd.panel_config WHERE device_id = $1`,
      [ids.equipoOrg],
    );
    expect(fila.payload.redes).toEqual([
      { ssid: SSID_FIXTURE, psw: PSW_FIXTURE, prio: 1 },
    ]);
  });

  it('sin espejo, el PUT devuelve 409 y no inventa una configuración', async () => {
    const res = await api(app)
      .put(`/api/devices/${ids.equipoSinEspejo}/config`)
      .set(auth(ana))
      .send({ patch: { tiempos: { send_tele_s: 600 } } })
      .expect(409);
    expect((res.body as { message: string }).message).toContain('cfg_full');
  });

  // ── Validación ─────────────────────────────────────────────────────

  it('send_tele_s por debajo del mínimo devuelve 400 nombrando el límite', async () => {
    const res = await api(app)
      .put(`/api/devices/${ids.equipoOrg}/config`)
      .set(auth(ana))
      .send({ patch: { tiempos: { send_tele_s: 29 } } })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('30');
  });

  it('seis redes devuelven 400', async () => {
    const redes = Array.from({ length: 6 }, (_, i) => ({
      ssid: `Red${i}`,
      psw: PSW_FIXTURE,
    }));
    await api(app)
      .put(`/api/devices/${ids.equipoOrg}/config`)
      .set(auth(ana))
      .send({ patch: { redes } })
      .expect(400);
  });

  it('un payload de más de 1024 bytes devuelve 400 con el tamaño real', async () => {
    const largo = 'x'.repeat(200);
    const redes = Array.from({ length: 5 }, (_, i) => ({
      ssid: `RedLarga${i}${largo}`,
      psw: `${largo}${i}`,
    }));
    const res = await api(app)
      .put(`/api/devices/${ids.equipoOrg}/config`)
      .set(auth(ana))
      .send({ patch: { redes } })
      .expect(400);
    expect((res.body as { message: string }).message).toContain('1024');
  });

  it('el payload rechazado NO deja rastro: la transacción se revierte', async () => {
    const [antes] = await dataSource.query<{ cfg_v: string }[]>(
      `SELECT cfg_v FROM gtd.panel_config WHERE device_id = $1`,
      [ids.equipoOrg],
    );
    const largo = 'y'.repeat(200);
    await api(app)
      .put(`/api/devices/${ids.equipoOrg}/config`)
      .set(auth(ana))
      .send({
        patch: {
          redes: Array.from({ length: 5 }, (_, i) => ({
            ssid: `Otra${i}${largo}`,
            psw: `${largo}${i}`,
          })),
        },
      })
      .expect(400);

    const [despues] = await dataSource.query<{ cfg_v: string }[]>(
      `SELECT cfg_v FROM gtd.panel_config WHERE device_id = $1`,
      [ids.equipoOrg],
    );
    // Ni se guardó la cfg gigante ni se quemó una versión.
    expect(despues.cfg_v).toBe(antes.cfg_v);
  });

  // ── Permisos ───────────────────────────────────────────────────────

  it('el MONITOR no puede publicar', async () => {
    await api(app)
      .put(`/api/devices/${ids.equipoOrg}/config`)
      .set(auth(moni))
      .send({ patch: { tiempos: { send_tele_s: 600 } } })
      .expect(403);
  });

  it('con managed_by = CPS la organización ve pero no publica', async () => {
    await api(app)
      .get(`/api/devices/${ids.equipoCps}/config`)
      .set(auth(ana))
      .expect(200);
    await api(app)
      .put(`/api/devices/${ids.equipoCps}/config`)
      .set(auth(ana))
      .send({ patch: { tiempos: { send_tele_s: 600 } } })
      .expect(403);
  });

  it('CPS publica en cualquier barrio, lo opere quien lo opere', async () => {
    await api(app)
      .put(`/api/devices/${ids.equipoCps}/config`)
      .set(auth(cps))
      .send({ patch: { tiempos: { send_tele_s: 600 } } })
      .expect(200);
  });

  // ── Revelar passwords ──────────────────────────────────────────────

  it('reveal-wifi: 403 para la organización, 200 para CPS', async () => {
    await api(app)
      .post(`/api/devices/${ids.equipoOrg}/config/reveal-wifi`)
      .set(auth(ana))
      .expect(403);

    const res = await api(app)
      .post(`/api/devices/${ids.equipoOrg}/config/reveal-wifi`)
      .set(auth(cps))
      .expect(201);
    expect(res.body).toEqual([{ ssid: SSID_FIXTURE, psw: PSW_FIXTURE }]);
  });

  it('reveal-wifi queda registrado en audit_log', async () => {
    await api(app)
      .post(`/api/devices/${ids.equipoOrg}/config/reveal-wifi`)
      .set(auth(cps))
      .expect(201);

    const filas = await dataSource.query<{ n: string }[]>(
      `SELECT count(1) AS n FROM audit_log
        WHERE action = 'device.config.reveal_wifi' AND entity_id = $1`,
      [String(ids.equipoOrg)],
    );
    expect(Number(filas[0].n)).toBeGreaterThan(0);
  });

  // ── Comandos ───────────────────────────────────────────────────────

  it('el scan encola un comando de tipo scan', async () => {
    await api(app)
      .post(`/api/devices/${ids.equipoOrg}/config/scan`)
      .set(auth(ana))
      .expect(201);

    const filas = await dataSource.query<{ tipo: string; estado: string }[]>(
      `SELECT tipo, estado FROM gtd.commands WHERE device_id = $1 AND tipo = 'scan'`,
      [ids.equipoOrg],
    );
    expect(filas).toHaveLength(1);
    expect(filas[0].estado).toBe('pending');
  });

  it('el refresh encola un comando de tipo refresh', async () => {
    await api(app)
      .post(`/api/devices/${ids.equipoSinEspejo}/config/refresh`)
      .set(auth(ana))
      .expect(201);

    const filas = await dataSource.query<{ tipo: string }[]>(
      `SELECT tipo FROM gtd.commands WHERE device_id = $1 AND tipo = 'refresh'`,
      [ids.equipoSinEspejo],
    );
    expect(filas).toHaveLength(1);
  });

  it('el MONITOR tampoco puede pedir un scan', async () => {
    await api(app)
      .post(`/api/devices/${ids.equipoOrg}/config/scan`)
      .set(auth(moni))
      .expect(403);
  });

  // ── Scan ───────────────────────────────────────────────────────────

  it('el último scan viaja en el GET, con la marca de guardada', async () => {
    await dataSource.query(
      `INSERT INTO gtd.uplink_raw (mac, tipo, payload, resultado)
       SELECT mac, 'scan', $2::jsonb, 'sin_destino' FROM device WHERE id = $1`,
      [
        ids.equipoOrg,
        JSON.stringify({
          redes: [
            { ssid: SSID_FIXTURE, rssi: -55, seg: true, ch: 6, guardada: true },
            { ssid: 'Vecino', rssi: -80, seg: true, ch: 11, guardada: false },
          ],
        }),
      ],
    );

    const res = await api(app)
      .get(`/api/devices/${ids.equipoOrg}/config`)
      .set(auth(ana))
      .expect(200);

    const body = res.body as {
      ultimoScan: { redes: { ssid: string; guardada: boolean }[] } | null;
    };
    expect(body.ultimoScan?.redes).toHaveLength(2);
    expect(body.ultimoScan?.redes[0].guardada).toBe(true);
  });
});
