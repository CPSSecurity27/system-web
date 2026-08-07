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

/** Los 7 modos con su default de fábrica, como los reporta el `cfg_full`. */
const AUTOOFF_FIXTURE = {
  suspicious: 120,
  alert: 300,
  emergency: 600,
  fire: 600,
  medical: 600,
  silent: 600,
  panic: 900,
};

/**
 * Cinco redes en el máximo que el panel acepta por campo (31 y 63): cada una
 * es válida, pero las cinco juntas no entran en los 1024 bytes de
 * `MQTT_IN_PAYLOAD_MAX`.
 *
 * Antes esto se armaba con SSIDs de 200 caracteres, que también pasaba de los
 * 1024 — pero desde que se validan los buffers del panel, ese patch muere una
 * validación antes y la guarda del payload quedaba sin probar.
 */
function redesMaximas(): { ssid: string; psw: string; prio: number }[] {
  return Array.from({ length: 5 }, (_, i) => ({
    ssid: `Red${i}`.padEnd(31, 'x'),
    psw: `Clave${i}`.padEnd(63, 'y'),
    prio: i + 1,
  }));
}

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
    // Un `cfg_full` completo, como el que arma el firmware: el merge de
    // `publish_config` reenvía TODAS estas secciones, así que un espejo pobre
    // hace que el payload medido sea más chico que el real.
    const payload = {
      cfg_v: cfgV,
      redes: [{ ssid: SSID_FIXTURE, psw: PSW_FIXTURE, prio: 1 }],
      modulos: {
        ds3231: true,
        eeprom: true,
        supervisor: true,
        rf: true,
        eeprom_slot: 0,
      },
      tiempos: { send_tele_s: 300 },
      hora: { tz_offset_s: -10800 },
      mante: { on: false },
      alarma: { autooff: { ...AUTOOFF_FIXTURE } },
      red_avanzada: { roam_rssi: -72, roam_delta: 10, roam_cooldown_s: 300 },
      rf: { total_codigos: 0, gen: 0 },
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
      { ssid: SSID_FIXTURE, prio: 1, tienePassword: true, bloqueada: false },
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
    // Cinco redes VÁLIDAS que igual no entran: es el caso que avisó el GtD
    // («una cfg completa de 5 redes puede no entrar en el panel»), y el único
    // que la validación por campo no puede agarrar.
    const res = await api(app)
      .put(`/api/devices/${ids.equipoOrg}/config`)
      .set(auth(ana))
      .send({ patch: { redes: redesMaximas() } })
      .expect(400);
    expect((res.body as { message: string }).message).toContain('1024');
  });

  it('el payload rechazado NO deja rastro: la transacción se revierte', async () => {
    const [antes] = await dataSource.query<{ cfg_v: string }[]>(
      `SELECT cfg_v FROM gtd.panel_config WHERE device_id = $1`,
      [ids.equipoOrg],
    );
    await api(app)
      .put(`/api/devices/${ids.equipoOrg}/config`)
      .set(auth(ana))
      .send({ patch: { redes: redesMaximas() } })
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

  // ── El rol también decide si el formulario se ve editable ──────────
  // No alcanza con que el PUT devuelva 403: si el GET dice que puede editar,
  // el MONITOR completa el formulario y se entera recién al apretar Guardar.

  it('el MONITOR ve la configuración pero con puedeEditar en false', async () => {
    const res = await api(app)
      .get(`/api/devices/${ids.equipoOrg}/config`)
      .set(auth(moni))
      .expect(200);

    const body = res.body as { puedeEditar: boolean; estado: string };
    expect(body.estado).not.toBe('SIN_ESPEJO');
    expect(body.puedeEditar).toBe(false);
  });

  it('puedeVerPasswords distingue a CPS de la organización', async () => {
    const deCps = await api(app)
      .get(`/api/devices/${ids.equipoOrg}/config`)
      .set(auth(cps))
      .expect(200);
    const deOrg = await api(app)
      .get(`/api/devices/${ids.equipoOrg}/config`)
      .set(auth(ana))
      .expect(200);

    expect((deCps.body as { puedeVerPasswords: boolean }).puedeVerPasswords).toBe(true);
    expect((deOrg.body as { puedeVerPasswords: boolean }).puedeVerPasswords).toBe(false);
  });

  // ── Los límites que faltaban ───────────────────────────────────────

  it('un huso horario fuera de ±14 h devuelve 400 y no llega al equipo', async () => {
    // El firmware descarta la cfg ENTERA sin mandar ack: si esto pasara, la
    // pantalla quedaría esperando una confirmación que no existe.
    const res = await api(app)
      .put(`/api/devices/${ids.equipoOrg}/config`)
      .set(auth(ana))
      .send({ patch: { hora: { tz_offset_s: 60000 } } })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('50400');
  });

  it('el huso horario de Argentina se acepta', async () => {
    await api(app)
      .put(`/api/devices/${ids.equipoOrg}/config`)
      .set(auth(ana))
      .send({ patch: { hora: { tz_offset_s: -10800 } } })
      .expect(200);
  });

  it('un auto-apagado fuera de rango devuelve 400 nombrando el modo', async () => {
    const res = await api(app)
      .put(`/api/devices/${ids.equipoOrg}/config`)
      .set(auth(ana))
      .send({ patch: { alarma: { autooff: { fire: 30 } } } })
      .expect(400);
    const cuerpo = JSON.stringify(res.body);
    expect(cuerpo).toContain('fire');
    expect(cuerpo).toContain('120');
  });

  it('el auto-apagado válido se publica y viaja en el payload', async () => {
    await api(app)
      .put(`/api/devices/${ids.equipoOrg}/config`)
      .set(auth(ana))
      .send({ patch: { alarma: { autooff: { fire: 900, panic: 1200 } } } })
      .expect(200);

    const [fila] = await dataSource.query<{ payload: Record<string, any> }[]>(
      `SELECT payload FROM gtd.panel_config WHERE device_id = $1`,
      [ids.equipoOrg],
    );
    expect(fila.payload.alarma.autooff.fire).toBe(900);
    expect(fila.payload.alarma.autooff.panic).toBe(1200);
  });

  it('un SSID más largo que el buffer del panel devuelve 400', async () => {
    const res = await api(app)
      .put(`/api/devices/${ids.equipoOrg}/config`)
      .set(auth(ana))
      .send({ patch: { redes: [{ ssid: 'x'.repeat(32), psw: PSW_FIXTURE }] } })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('31');
  });

  it('el slot de eeprom fuera de 0..1 devuelve 400', async () => {
    await api(app)
      .put(`/api/devices/${ids.equipoOrg}/config`)
      .set(auth(ana))
      .send({ patch: { modulos: { eeprom_slot: 2 } } })
      .expect(400);
  });

  it('el roaming incompleto devuelve 400: a medias descarta la cfg entera', async () => {
    const res = await api(app)
      .put(`/api/devices/${ids.equipoOrg}/config`)
      .set(auth(ana))
      .send({ patch: { red_avanzada: { roam_rssi: -70 } } })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('roam_delta');
  });

  // ── Vuelta a fábrica ───────────────────────────────────────────────

  /** Un equipo propio: estos casos ensucian la cola y no deben arrastrar al resto. */
  async function equipoPropio(mac: string, seq: number): Promise<number> {
    const [bm] = await dataSource.query<{ id: number }[]>(
      `SELECT id FROM board_model WHERE code = 'ALOY'`,
    );
    const [equipo] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO device (serial, mac, type, status, board_model_id, board_seq,
                           neighborhood_id, latitude, longitude)
       VALUES ($1,$2,'COMMUNITY_ALARM','OPERATIONAL',$3,$4,$5,-31.42,-64.18)
       RETURNING id`,
      ['AV-' + mac, mac, bm.id, seq, ids.barrioOrg],
    );
    return equipo.id;
  }

  it('el tele reconcilia solo: con el cfg_v del panel la cola queda applied', async () => {
    // La red silenciosa de la escalera de confirmación. El `tele` es retained,
    // así que es la ÚNICA señal que sobrevive a un GtD caído: si el ack y el
    // cfg_full encadenado se pierden, esto es lo que saca la pantalla de
    // "esperando confirmación".
    const mac = 'AABBCCDDEE05';
    const equipoId = await equipoPropio(mac, 5);
    await sembrarEspejo(equipoId, 5);

    await api(app)
      .put(`/api/devices/${equipoId}/config`)
      .set(auth(ana))
      .send({ patch: { tiempos: { send_tele_s: 600 } } })
      .expect(200);

    const [encolada] = await dataSource.query<{ estado: string; cfg_v: string }[]>(
      `SELECT estado, cfg_v FROM gtd.panel_config WHERE device_id = $1`,
      [equipoId],
    );
    expect(encolada.estado).toBe('pending');

    // Llega un tele diciendo que corre esa misma versión.
    await dataSource.query(
      `SELECT gtd.upsert_panel_state(p_mac => $1, p_estado => 'online', p_cfg_v => $2::BIGINT)`,
      [mac, encolada.cfg_v],
    );

    const [despues] = await dataSource.query<{ estado: string }[]>(
      `SELECT estado FROM gtd.panel_config WHERE device_id = $1`,
      [equipoId],
    );
    expect(despues.estado).toBe('applied');
  });

  it('con la cola en stale el estado es DESACTUALIZADA, no VERIFICADO', async () => {
    const equipo = { id: await equipoPropio('AABBCCDDEE04', 4) };
    await sembrarEspejo(equipo.id, 5);

    await api(app)
      .put(`/api/devices/${equipo.id}/config`)
      .set(auth(ana))
      .send({ patch: { tiempos: { send_tele_s: 600 } } })
      .expect(200);

    // El panel aplicó la 6 y la espejó: hasta acá, verificado.
    await sembrarEspejo(equipo.id, 6);
    const antes = await api(app)
      .get(`/api/devices/${equipo.id}/config`)
      .set(auth(ana))
      .expect(200);
    expect((antes.body as { estado: string }).estado).toBe('VERIFICADO');

    // Ahora el factory: el panel reporta cfg_v = 0 y la cola queda stale. El
    // espejo NO se deja pisar por una versión más vieja, así que sigue en 6 —
    // y la comparación de versiones daría VERIFICADO sobre defaults de fábrica.
    await dataSource.query(
      `SELECT gtd.upsert_panel_state(p_mac => $1, p_estado => 'online', p_cfg_v => 0)`,
      ['AABBCCDDEE04'],
    );

    const despues = await api(app)
      .get(`/api/devices/${equipo.id}/config`)
      .set(auth(ana))
      .expect(200);
    expect((despues.body as { estado: string }).estado).toBe('DESACTUALIZADA');
  });

  // ── Comandos al panel ──────────────────────────────────────────────

  it('un comando se encola con su payload y aparece en la lista', async () => {
    await api(app)
      .post(`/api/devices/${ids.equipoOrg}/commands`)
      .set(auth(ana))
      .send({ tipo: 'estado' })
      .expect(201);

    const res = await api(app)
      .get(`/api/devices/${ids.equipoOrg}/commands`)
      .set(auth(ana))
      .expect(200);

    const cola = res.body as {
      comandos: {
        tipo: string;
        estado: string;
        cancelable: boolean;
        pedidoPor: string | null;
      }[];
      puedeOperar: boolean;
    };
    expect(cola.puedeOperar).toBe(true);
    const estado = cola.comandos.find((c) => c.tipo === 'estado');
    expect(estado?.estado).toBe('pending');
    expect(estado?.cancelable).toBe(true);
    expect(estado?.pedidoPor).toBe('Ana Admin');
  });

  it('el MONITOR ve la cola pero no puede encolar', async () => {
    await api(app)
      .get(`/api/devices/${ids.equipoOrg}/commands`)
      .set(auth(moni))
      .expect(200);
    await api(app)
      .post(`/api/devices/${ids.equipoOrg}/commands`)
      .set(auth(moni))
      .send({ tipo: 'restart' })
      .expect(403);
  });

  it('con managed_by = CPS la organización no manda comandos', async () => {
    await api(app)
      .post(`/api/devices/${ids.equipoCps}/commands`)
      .set(auth(ana))
      .send({ tipo: 'restart' })
      .expect(403);
  });

  it('destrabar una red sin decir cuál devuelve 400', async () => {
    await api(app)
      .post(`/api/devices/${ids.equipoOrg}/commands`)
      .set(auth(ana))
      .send({ tipo: 'red' })
      .expect(400);
  });

  it('un tipo que no está en el catálogo devuelve 400', async () => {
    // `rf` y `cal` existen en el firmware y en el CHECK de la base, pero la web
    // todavía no los manda: el DTO es la puerta.
    for (const tipo of ['rf', 'cal', 'inventado']) {
      await api(app)
        .post(`/api/devices/${ids.equipoOrg}/commands`)
        .set(auth(ana))
        .send({ tipo })
        .expect(400);
    }
  });

  // ── factory: la fricción no se saltea ──────────────────────────────

  it('factory sin escribir el serial devuelve 400', async () => {
    const res = await api(app)
      .post(`/api/devices/${ids.equipoOrg}/commands`)
      .set(auth(ana))
      .send({ tipo: 'factory' })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('AV-AABBCCDDEE01');
  });

  it('factory con el serial de OTRO equipo devuelve 400', async () => {
    await api(app)
      .post(`/api/devices/${ids.equipoOrg}/commands`)
      .set(auth(ana))
      .send({ tipo: 'factory', confirmacion: 'AV-AABBCCDDEE02' })
      .expect(400);
  });

  it('factory con el serial correcto viaja con el confirm que el panel espera', async () => {
    await api(app)
      .post(`/api/devices/${ids.equipoOrg}/commands`)
      .set(auth(ana))
      .send({ tipo: 'factory', confirmacion: 'AV-AABBCCDDEE01' })
      .expect(201);

    const [fila] = await dataSource.query<{ payload: { confirm: string } }[]>(
      `SELECT payload FROM gtd.commands
        WHERE device_id = $1 AND tipo = 'factory'
        ORDER BY created_at DESC LIMIT 1`,
      [ids.equipoOrg],
    );
    expect(fila.payload.confirm).toBe('AV-AABBCCDDEE01');
  });

  // ── Disparo remoto: la única acción que suma al MONITOR ────────────

  it('el MONITOR SÍ puede disparar la alarma', async () => {
    await api(app)
      .post(`/api/devices/${ids.equipoOrg}/alarm`)
      .set(auth(moni))
      .send({ modo: 'emergency' })
      .expect(201);

    const [fila] = await dataSource.query<{ payload: { mode: string } }[]>(
      `SELECT payload FROM gtd.commands
        WHERE device_id = $1 AND tipo = 'alarma'
        ORDER BY created_at DESC LIMIT 1`,
      [ids.equipoOrg],
    );
    expect(fila.payload.mode).toBe('emergency');
  });

  it('un modo que no existe devuelve 400', async () => {
    await api(app)
      .post(`/api/devices/${ids.equipoOrg}/alarm`)
      .set(auth(ana))
      .send({ modo: 'incendio' }) // el slug del firmware es `fire`
      .expect(400);
  });

  it('el monitor tampoco dispara en un barrio que opera CPS', async () => {
    await api(app)
      .post(`/api/devices/${ids.equipoCps}/alarm`)
      .set(auth(moni))
      .send({ modo: 'off' })
      .expect(403);
  });

  // ── Cancelar ───────────────────────────────────────────────────────

  it('un comando pendiente se cancela; uno ya enviado, no', async () => {
    const encolar = await api(app)
      .post(`/api/devices/${ids.equipoOrg}/commands`)
      .set(auth(ana))
      .send({ tipo: 'i2c_scan' })
      .expect(201);

    const cid = (
      encolar.body as { comandos: { cid: string; tipo: string }[] }
    ).comandos.find((c) => c.tipo === 'i2c_scan')!.cid;

    const cancelado = await api(app)
      .post(`/api/devices/${ids.equipoOrg}/commands/${cid}/cancel`)
      .set(auth(ana))
      .expect(201);
    expect(
      (
        cancelado.body as { comandos: { cid: string; estado: string }[] }
      ).comandos.find((c) => c.cid === cid)?.estado,
    ).toBe('cancelled');

    // Cancelar dos veces no revive nada: ya no está pendiente.
    await api(app)
      .post(`/api/devices/${ids.equipoOrg}/commands/${cid}/cancel`)
      .set(auth(ana))
      .expect(409);
  });

  it('no se puede cancelar el comando de otro equipo', async () => {
    const [ajeno] = await dataSource.query<{ cid: string }[]>(
      `SELECT gtd.enqueue_command($1, 'estado', '{}'::jsonb, NULL) AS cid`,
      [ids.equipoCps],
    );
    await api(app)
      .post(`/api/devices/${ids.equipoOrg}/commands/${ajeno.cid}/cancel`)
      .set(auth(ana))
      .expect(404);
  });

  // ── Copiar configuración de otro equipo ────────────────────────────

  it('las fuentes para copiar son del mismo barrio y con espejo', async () => {
    const res = await api(app)
      .get(`/api/devices/${ids.equipoOrg}/config/sources`)
      .set(auth(ana))
      .expect(200);

    const fuentes = res.body as { deviceId: number; serial: string }[];
    const ids_ = fuentes.map((f) => f.deviceId);
    // El de otro barrio no está, el sin espejo tampoco, y uno no se copia a sí mismo.
    expect(ids_).not.toContain(ids.equipoCps);
    expect(ids_).not.toContain(ids.equipoSinEspejo);
    expect(ids_).not.toContain(ids.equipoOrg);
  });

  // ── Redes bloqueadas por el equipo ─────────────────────────────────

  it('una red en la lista negra del panel viaja marcada', async () => {
    await sembrarEspejo(ids.equipoCps, 9, {
      redes: [
        { ssid: SSID_FIXTURE, psw: PSW_FIXTURE, prio: 1, bl_perm: true },
        { ssid: 'Vecino', psw: PSW_FIXTURE, prio: 2, bl_perm: false },
      ],
    });

    const res = await api(app)
      .get(`/api/devices/${ids.equipoCps}/config`)
      .set(auth(ana))
      .expect(200);

    const redes = (res.body as { redes: { ssid: string; bloqueada: boolean }[] })
      .redes;
    expect(redes[0].bloqueada).toBe(true);
    expect(redes[1].bloqueada).toBe(false);
    // Y sigue sin haber una sola password en la respuesta.
    expect(JSON.stringify(res.body)).not.toContain(PSW_FIXTURE);
  });
});
