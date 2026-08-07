import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PasswordService } from '../src/auth/password.service';
import { UserRole } from '../src/common/enums';
import { CLAVE, api, crearApp, login } from './helpers';

/**
 * Cargar la base RF en el panel: de la web a la EEPROM.
 *
 * Lo que se prueba acá no es "el endpoint responde 200": es la CADENA, que es
 * lo que nadie puede ver de un vistazo. Un plan se encola entero pero sale de a
 * un paso, cada ack destraba el siguiente, y recién cuando el equipo dice que
 * guardó, el control queda marcado como cargado.
 *
 * El ack lo simula `gtd.confirm_command`, que es exactamente lo que llama el
 * GtD cuando el panel contesta. Sin broker ni firmware de por medio: lo que se
 * ejercita es el contrato de la base, que es nuestro.
 */
describe('Sincronización de base RF (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let cps: string;
  let ana: string; // ADMIN de la muni
  let ids: {
    org: number;
    barrio: number;
    casa: number;
    equipo: number;
    modelo: number;
  };

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  interface EstadoRf {
    sinAlarma: { remoteId: number; homeId: number; direccion: string }[];
    capacidad: { tope: number; ocupados: number };
    alDia: number;
    pendientes: {
      remoteId: number;
      serial: string | null;
      dni: string | null;
    }[];
    bajas: { dni: string; serial: string | null; motivo: string }[];
    salteados: { remoteId: number; motivo: string; explicacion: string }[];
    tanda: {
      batchId: string;
      total: number;
      hechos: number;
      estado: string;
      detalle: string | null;
    } | null;
    puedeSincronizar: boolean;
    impedimento: string | null;
  }

  const estado = async (token = ana): Promise<EstadoRf> =>
    (
      await api(app)
        .get(`/api/devices/${ids.equipo}/rf`)
        .set(auth(token))
        .expect(200)
    ).body as EstadoRf;

  const sincronizar = async (token = ana, espera = 201): Promise<EstadoRf> =>
    (
      await api(app)
        .post(`/api/devices/${ids.equipo}/rf/sync`)
        .set(auth(token))
        .send({})
        .expect(espera)
    ).body as EstadoRf;

  /** Los pasos encolados de la última tanda, en orden. */
  const pasos = async (): Promise<
    { seq: number; estado: string; op: string; gen: number; cid: string }[]
  > =>
    dataSource.query(
      `SELECT seq, estado, payload->>'op' AS op, (payload->>'gen')::INT AS gen, cid
         FROM gtd.commands
        WHERE device_id = $1 AND batch_id = (
              SELECT batch_id FROM gtd.commands
               WHERE device_id = $1 AND batch_id IS NOT NULL
               ORDER BY created_at DESC LIMIT 1)
        ORDER BY seq`,
      [ids.equipo],
    );

  /** El ack del panel, tal como lo manda el GtD. */
  const ack = (cid: string, res = 'ok', det = 'guardados 1') =>
    dataSource.query(`SELECT gtd.confirm_command($1, $2, $3)`, [cid, res, det]);

  /** Fabrica un control y lo entrega a un vecino nuevo de la casa. */
  let nVecinos = 0;
  async function entregar(): Promise<{
    id: number;
    serial: string;
    dni: string;
  }> {
    const res = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: ids.modelo })
      .expect(201);
    const control = res.body as { id: number; serial: string };
    await api(app)
      .post(`/api/remotes/${control.id}/ready`)
      .set(auth(cps))
      .send({})
      .expect(201);

    nVecinos++;
    const dni = String(31000000 + nVecinos);
    const [u] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO app_user (name, dni, status) VALUES ($1,$2,'ACTIVE') RETURNING id`,
      [`Vecino ${nVecinos}`, dni],
    );
    await dataSource.query(
      `INSERT INTO home_member (home_id, user_id, role, status)
       VALUES ($1,$2,'FAMILIAR','ACTIVE')`,
      [ids.casa, u.id],
    );
    await api(app)
      .post(`/api/remotes/${control.id}/assign`)
      .set(auth(cps))
      .send({ homeId: ids.casa, assignedToUserId: u.id })
      .expect(201);

    return { id: control.id, serial: control.serial, dni };
  }

  beforeAll(async () => {
    app = await crearApp();
    dataSource = app.get(DataSource);

    await dataSource.query(`
      TRUNCATE remote_code, remote, device_maintenance, device_state, device,
               service_contract, home_member, home, neighborhood, account_user,
               account, user_token, refresh_token, app_user, locality,
               department, province, audit_log, gtd.commands
      RESTART IDENTITY CASCADE
    `);
    await dataSource.query(`ALTER SEQUENCE remote_serial_seq RESTART WITH 1`);

    const hash = await app.get(PasswordService).hash(CLAVE);

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

    const [cpsAcc] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO account (name, type, status)
       VALUES ('CPS Security','COMPANY','ACTIVE') RETURNING id`,
    );
    const [cpsUser] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO app_user (name, username, password_hash, status)
       VALUES ('Admin CPS','admin',$1,'ACTIVE') RETURNING id`,
      [hash],
    );
    await dataSource.query(
      `INSERT INTO account_user (account_id, user_id, role) VALUES ($1,$2,'ADMIN')`,
      [cpsAcc.id, cpsUser.id],
    );

    const [org] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO account (name, type, subtype, status, jurisdiction_level, locality_id,
                            latitude, longitude, max_neighborhoods, max_admin_users,
                            max_technician_users, max_monitor_users, max_family_members,
                            community_scope_enabled)
       VALUES ('Municipalidad de Córdoba','ORGANIZATION','MUNICIPAL','ACTIVE','LOCALITY',$1,
               -31.42,-64.18, 10, 5, 5, 5, 80, true)
       RETURNING id`,
      [loc.id],
    );
    const [anaUser] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO app_user (name, username, password_hash, status)
       VALUES ('Ana Admin','ana',$1,'ACTIVE') RETURNING id`,
      [hash],
    );
    await dataSource.query(
      `INSERT INTO account_user (account_id, user_id, role) VALUES ($1,$2,$3)`,
      [org.id, anaUser.id, UserRole.ADMIN],
    );

    const [barrio] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO neighborhood (name, code, locality_id, latitude, longitude,
                                 organization_id, organization_type, managed_by,
                                 max_family_members, community_scope_enabled, status)
       VALUES ('Barrio Jardín','JARDIN',$1,-31.42,-64.18,$2,'ORGANIZATION',
               'ORGANIZATION',80,true,'ACTIVE')
       RETURNING id`,
      [loc.id, org.id],
    );

    // El equipo: instalado, con MAC y con su placa (chk_device_identity).
    // El catálogo de placas NO se trunca (lo siembra una migración y lo
    // comparten las suites): se toma la que haya, o se crea.
    const [placa] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO board_model (code, name) VALUES ('ALOY','Placa v6')
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
    );
    const MAC = 'AABBCCDDEE01';
    const [equipo] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO device (serial, mac, type, status, board_model_id, board_seq,
                           neighborhood_id, latitude, longitude)
       VALUES ($1,$2,'COMMUNITY_ALARM','OPERATIONAL',$3,1,$4,-31.42,-64.18)
       RETURNING id`,
      [`AV-${MAC}`, MAC, placa.id, barrio.id],
    );

    // La vivienda, con ESE equipo como alarma preferida: es lo que decide qué
    // controles le tocan.
    const [casa] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO home (address, neighborhood_id, latitude, longitude, status,
                         default_device_id)
       VALUES ('Belgrano 123',$1,-31.42,-64.18,'ACTIVE',$2) RETURNING id`,
      [barrio.id, equipo.id],
    );

    cps = await login(app, 'admin');
    ana = await login(app, 'ana');

    const [modelo] = await dataSource.query<{ id: number }[]>(
      `SELECT id FROM remote_model WHERE code = 'CR4'`,
    );

    ids = {
      org: org.id,
      barrio: barrio.id,
      casa: casa.id,
      equipo: equipo.id,
      modelo: modelo.id,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Cada test arranca con el equipo vacío, sin controles de los anteriores y
    // sin tandas colgadas: si no, "el primer lote" deja de significar lo mismo
    // en cada test según cuántos controles arrastró el que corrió antes.
    await dataSource.query(`DELETE FROM gtd.commands WHERE device_id = $1`, [
      ids.equipo,
    ]);
    await dataSource.query(`DELETE FROM remote_code`);
    await dataSource.query(`DELETE FROM remote`);
  });

  /** El panel contestando toda la tanda, un paso por vez, como en la vida real. */
  async function completarTanda(): Promise<void> {
    for (;;) {
      const [siguiente] = await dataSource.query<{ cid: string }[]>(
        `SELECT cid FROM gtd.commands
          WHERE device_id = $1 AND estado IN ('pending', 'sent')
          ORDER BY seq LIMIT 1`,
        [ids.equipo],
      );
      if (!siguiente) return;
      await ack(siguiente.cid);
    }
  }

  // ── El estado ──────────────────────────────────────────────────────

  it('sin controles no hay nada que mandar', async () => {
    const e = await estado();
    expect(e.pendientes).toHaveLength(0);
    expect(e.alDia).toBe(0);
    expect(e.puedeSincronizar).toBe(true);
    // Sin telemetría se asume el chip más chico: 126 vecinos.
    expect(e.capacidad.tope).toBe(126);
  });

  it('un control entregado aparece como pendiente', async () => {
    const control = await entregar();

    const e = await estado();
    expect(e.pendientes.map((p) => p.remoteId)).toContain(control.id);
    expect(e.pendientes[0].dni).toBe(control.dni);
  });

  it('el equipo sin instalar no se puede sincronizar, y lo dice', async () => {
    const [suelto] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO device (serial, mac, type, status, board_model_id, board_seq)
       VALUES ('AV-AABBCCDDEE02','AABBCCDDEE02','COMMUNITY_ALARM','INVENTORY',
               (SELECT id FROM board_model LIMIT 1), 2)
       RETURNING id`,
    );
    const res = await api(app)
      .get(`/api/devices/${suelto.id}/rf`)
      .set(auth(cps))
      .expect(200);

    const e = res.body as EstadoRf;
    expect(e.puedeSincronizar).toBe(false);
    expect(e.impedimento).toContain('no está instalado');
  });

  // ── Los que no se pueden cargar ────────────────────────────────────

  it('un control sin portador se saltea, con el motivo', async () => {
    const control = await entregar();
    // Se lo sacan: queda "en el cajón de la casa".
    await api(app)
      .patch(`/api/remotes/${control.id}`)
      .set(auth(cps))
      .send({ assignedToUserId: null })
      .expect(200);

    const e = await estado();
    const salteado = e.salteados.find((s) => s.remoteId === control.id);
    expect(salteado?.motivo).toBe('SIN_PORTADOR');
    expect(salteado?.explicacion).toContain('POR PERSONA');
    expect(e.pendientes.map((p) => p.remoteId)).not.toContain(control.id);
  });

  it('un control con hueco de posición se saltea: el equipo no sabe recibirlo', async () => {
    const control = await entregar();
    // Le borran el botón B: quedan las posiciones 1, 3 y 4.
    const codigos = (
      await api(app)
        .get(`/api/remotes/${control.id}/codes`)
        .set(auth(cps))
        .expect(200)
    ).body as { id: number; position: number }[];
    const segundo = codigos.find((c) => c.position === 2);
    await api(app)
      .delete(`/api/remotes/${control.id}/codes/${segundo?.id}`)
      .set(auth(cps))
      .expect(204);

    const e = await estado();
    expect(e.salteados.find((s) => s.remoteId === control.id)?.motivo).toBe(
      'POSICIONES_CON_HUECO',
    );
  });

  // ── La cadena ──────────────────────────────────────────────────────

  it('sincronizar encola la tanda pero sale UN paso a la vez', async () => {
    for (let i = 0; i < 7; i++) await entregar();

    const e = await sincronizar();
    expect(e.tanda?.estado).toBe('en_curso');

    // 7 controles = 2 lotes de a 5.
    const cola = await pasos();
    expect(cola).toHaveLength(2);
    expect(cola.map((p) => p.estado)).toEqual(['pending', 'queued']);
    // Un `gen` por comando: el que el panel reporte dice hasta dónde llegó.
    expect(cola[1].gen).toBe(cola[0].gen + 1);
  });

  it('el ack destraba el siguiente y marca los controles cargados', async () => {
    const a = await entregar();
    const b = await entregar();
    await sincronizar();

    await completarTanda();

    const e = await estado();
    expect(e.alDia).toBe(2);
    expect(e.pendientes).toHaveLength(0);
    expect(e.tanda?.estado).toBe('terminada');

    // Y quedó registrado CON QUÉ DNI: es lo único que permite darlos de baja
    // después, cuando el control ya no tenga portador.
    const marcados = await dataSource.query<
      { id: number; synced_dni: string; synced_device_id: number }[]
    >(
      `SELECT id, synced_dni, synced_device_id FROM remote
        WHERE id = ANY($1) ORDER BY id`,
      [[a.id, b.id]],
    );
    expect(marcados.map((m) => m.synced_dni)).toEqual([a.dni, b.dni]);
    expect(marcados.every((m) => m.synced_device_id === ids.equipo)).toBe(true);
  });

  it('un paso que falla corta la tanda y lo explica en castellano', async () => {
    for (let i = 0; i < 7; i++) await entregar();
    await sincronizar();

    const cola = await pasos();
    // ee_status 2 = EE_FULL: la memoria del equipo se llenó.
    await ack(cola[0].cid, 'error', 'ee_status 2 (guardados 3)');

    const e = await estado();
    expect(e.tanda?.estado).toBe('con_error');
    expect(e.tanda?.detalle).toContain('memoria del equipo está llena');
    // Y lo que quedaba no se manda: cargar sobre una base a medias encadena
    // errores.
    expect((await pasos())[1].estado).toBe('cancelled');
  });

  it('no se encola una segunda tanda con una en vuelo', async () => {
    await entregar();
    await sincronizar();

    const res = await api(app)
      .post(`/api/devices/${ids.equipo}/rf/sync`)
      .set(auth(ana))
      .send({})
      .expect(409);
    expect(JSON.stringify(res.body)).toContain('en curso');
  });

  it('con todo al día no hay nada que sincronizar', async () => {
    await entregar();
    await sincronizar();
    await completarTanda();

    const res = await api(app)
      .post(`/api/devices/${ids.equipo}/rf/sync`)
      .set(auth(ana))
      .send({})
      .expect(409);
    expect(JSON.stringify(res.body)).toContain(
      'ya tiene lo que le corresponde',
    );
  });

  // ── Las bajas ──────────────────────────────────────────────────────

  it('un control devuelto al stock se da de baja del equipo', async () => {
    const control = await entregar();
    await sincronizar();
    await completarTanda();

    await api(app)
      .post(`/api/remotes/${control.id}/return`)
      .set(auth(ana))
      .expect(201);

    const e = await estado();
    expect(e.bajas).toHaveLength(1);
    // El DNI sale de synced_dni: el control ya no tiene portador.
    expect(e.bajas[0].dni).toBe(control.dni);
    expect(e.bajas[0].motivo).toContain('stock');

    await sincronizar();
    const cola = await pasos();
    expect(cola[0].op).toBe('del');

    // El ack de la baja limpia la marca: el equipo ya no lo tiene.
    await ack(cola[0].cid, 'ok', 'ok');
    const [fila] = await dataSource.query<
      { synced_device_id: number | null }[]
    >(`SELECT synced_device_id FROM remote WHERE id = $1`, [control.id]);
    expect(fila.synced_device_id).toBeNull();
  });

  /**
   * El agujero que esto viene a tapar: hasta ahora, reportar un llavero perdido
   * era un acto administrativo y el panel lo seguía atendiendo.
   */
  it('un control perdido se saca del equipo', async () => {
    const control = await entregar();
    await sincronizar();
    await completarTanda();

    await api(app)
      .patch(`/api/remotes/${control.id}`)
      .set(auth(cps))
      .send({ status: 'LOST' })
      .expect(200);

    const e = await estado();
    expect(e.bajas[0].motivo).toContain('perdido');
    expect(e.alDia).toBe(0);
  });

  it('cambiarle el portador es baja del viejo y alta del nuevo, en ese orden', async () => {
    const control = await entregar();
    await sincronizar();
    await completarTanda();

    // Otro miembro de la casa se lo lleva.
    const [otro] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO app_user (name, dni, status)
       VALUES ('Otro Vecino','32999888','ACTIVE') RETURNING id`,
    );
    await dataSource.query(
      `INSERT INTO home_member (home_id, user_id, role, status)
       VALUES ($1,$2,'FAMILIAR','ACTIVE')`,
      [ids.casa, otro.id],
    );
    await api(app)
      .patch(`/api/remotes/${control.id}`)
      .set(auth(cps))
      .send({ assignedToUserId: otro.id })
      .expect(200);

    await sincronizar();
    const cola = await pasos();
    // La baja PRIMERO: si el alta fuera antes, el equipo la rechazaría con
    // EE_DUP —los códigos ya son de alguien— y abortaría el lote.
    expect(cola.map((p) => p.op)).toEqual(['del', 'batch']);
  });

  /**
   * El caso que hizo perder una hora en producción (2026-08-06): se asigna un
   * control, y la pantalla del equipo muestra CERO pendientes — indistinguible
   * de "todo al día". El motivo era que la vivienda no tenía alarma preferida,
   * y el plan de cada equipo sale justamente de las casas que lo eligieron.
   */
  it('avisa de los controles cuya casa no eligió alarma preferida', async () => {
    // Una casa del mismo barrio, SIN alarma preferida, con su control.
    const [otra] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO home (address, neighborhood_id, latitude, longitude, status)
       VALUES ('Casa sin alarma',$1,-31.42,-64.18,'ACTIVE') RETURNING id`,
      [ids.barrio],
    );
    const res = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: ids.modelo })
      .expect(201);
    const control = res.body as { id: number };
    await api(app)
      .post(`/api/remotes/${control.id}/ready`)
      .set(auth(cps))
      .send({})
      .expect(201);
    nVecinos++;
    const [u] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO app_user (name, dni, status) VALUES ($1,$2,'ACTIVE') RETURNING id`,
      [`Vecino huerfano ${nVecinos}`, String(32000000 + nVecinos)],
    );
    await dataSource.query(
      `INSERT INTO home_member (home_id, user_id, role, status)
       VALUES ($1,$2,'TITULAR','ACTIVE')`,
      [otra.id, u.id],
    );
    await api(app)
      .post(`/api/remotes/${control.id}/assign`)
      .set(auth(cps))
      .send({ homeId: otra.id, assignedToUserId: u.id })
      .expect(201);

    const e = await estado();
    // No es pendiente de ESTE equipo: no le toca a ninguno.
    expect(e.pendientes.map((p) => p.remoteId)).not.toContain(control.id);
    const huerfano = e.sinAlarma.find((c) => c.remoteId === control.id);
    expect(huerfano?.direccion).toBe('Casa sin alarma');
    // Y trae el id de la casa: la pantalla linkea ahí para arreglarlo.
    expect(huerfano?.homeId).toBe(otra.id);
  });

  it('elegida la alarma preferida, el control pasa a pendiente', async () => {
    const [otra] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO home (address, neighborhood_id, latitude, longitude, status)
       VALUES ('Casa que despues elige',$1,-31.42,-64.18,'ACTIVE') RETURNING id`,
      [ids.barrio],
    );
    const res = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: ids.modelo })
      .expect(201);
    const control = res.body as { id: number };
    await api(app)
      .post(`/api/remotes/${control.id}/ready`)
      .set(auth(cps))
      .send({})
      .expect(201);
    nVecinos++;
    const [u] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO app_user (name, dni, status) VALUES ($1,$2,'ACTIVE') RETURNING id`,
      [`Vecino tardio ${nVecinos}`, String(33000000 + nVecinos)],
    );
    await dataSource.query(
      `INSERT INTO home_member (home_id, user_id, role, status)
       VALUES ($1,$2,'TITULAR','ACTIVE')`,
      [otra.id, u.id],
    );
    await api(app)
      .post(`/api/remotes/${control.id}/assign`)
      .set(auth(cps))
      .send({ homeId: otra.id, assignedToUserId: u.id })
      .expect(201);

    expect(
      (await estado()).sinAlarma.some((c) => c.remoteId === control.id),
    ).toBe(true);

    // La casa elige el equipo: es exactamente lo que hace el selector nuevo de
    // la ficha de la vivienda.
    await api(app)
      .patch(`/api/homes/${otra.id}`)
      .set(auth(cps))
      .send({ defaultDeviceId: ids.equipo })
      .expect(200);

    const e = await estado();
    expect(e.sinAlarma.some((c) => c.remoteId === control.id)).toBe(false);
    expect(e.pendientes.map((p) => p.remoteId)).toContain(control.id);
  });

  // ── Los secretos ───────────────────────────────────────────────────

  it('el código deja de estar en la cola cuando el comando se cumple', async () => {
    await entregar();
    await sincronizar();

    const antes = await dataSource.query<{ tiene: boolean }[]>(
      `SELECT payload ? 'clientes' AS tiene FROM gtd.commands
        WHERE device_id = $1 ORDER BY seq LIMIT 1`,
      [ids.equipo],
    );
    expect(antes[0].tiene).toBe(true);

    await ack((await pasos())[0].cid);

    const despues = await dataSource.query<
      { tiene: boolean; resumen: string }[]
    >(
      `SELECT payload ? 'clientes' AS tiene, payload->>'clientes_n' AS resumen
         FROM gtd.commands WHERE device_id = $1 ORDER BY seq LIMIT 1`,
      [ids.equipo],
    );
    expect(despues[0].tiene).toBe(false);
    expect(despues[0].resumen).toBe('1');
  });

  it('lo NUESTRO del comando no viaja al panel', async () => {
    await entregar();
    await sincronizar();

    const [fila] = await dataSource.query<
      { payload: Record<string, unknown>; meta: Record<string, unknown> }[]
    >(
      `SELECT payload, meta FROM gtd.commands
        WHERE device_id = $1 ORDER BY seq LIMIT 1`,
      [ids.equipo],
    );
    // El payload es lo que se publica: solo el protocolo del firmware.
    expect(Object.keys(fila.payload).sort()).toEqual([
      'cid',
      'clientes',
      'gen',
      'op',
      't',
    ]);
    expect(fila.meta.remotes).toBeDefined();
  });

  it('un lote entra en el payload que el panel acepta', async () => {
    for (let i = 0; i < 5; i++) await entregar();
    await sincronizar();

    const [fila] = await dataSource.query<{ bytes: string }[]>(
      `SELECT octet_length(payload::TEXT) AS bytes FROM gtd.commands
        WHERE device_id = $1 ORDER BY seq LIMIT 1`,
      [ids.equipo],
    );
    // MQTT_IN_PAYLOAD_MAX: lo que pasa de ahí el equipo lo descarta EN SILENCIO.
    expect(Number(fila.bytes)).toBeLessThan(1024);
  });

  // ── Permisos ───────────────────────────────────────────────────────

  it('mirar la base no es poder cargarla', async () => {
    const [monitorUser] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO app_user (name, username, password_hash, status)
       VALUES ('Mario Monitor','mario',
               (SELECT password_hash FROM app_user WHERE username = 'ana'),
               'ACTIVE') RETURNING id`,
    );
    await dataSource.query(
      `INSERT INTO account_user (account_id, user_id, role) VALUES ($1,$2,$3)`,
      [ids.org, monitorUser.id, UserRole.MONITOR],
    );
    const monitor = await login(app, 'mario');

    // Ve el estado (entender por qué un control no dispara es parte de mirar)…
    const e = await estado(monitor);
    expect(e.puedeSincronizar).toBe(false);
    expect(e.impedimento).toContain('rol');

    // …pero el guard lo frena.
    await api(app)
      .post(`/api/devices/${ids.equipo}/rf/sync`)
      .set(auth(monitor))
      .send({})
      .expect(403);
  });
});
