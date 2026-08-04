import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PasswordService } from '../src/auth/password.service';
import { UserRole } from '../src/common/enums';
import { CLAVE, api, crearApp, login } from './helpers';

/**
 * Alta y baja de credenciales en el broker — integración contra la base real.
 *
 * NO usa `sembrar()` de `helpers.ts`: ese arma el modelo v1 y está en rojo desde
 * la migración a v2. Acá se siembra lo mínimo del modelo v2, directo por el
 * DataSource.
 *
 * Lo que importa: que el alta de fábrica encole SOLA (es lo que hace posible una
 * tanda), que solo CPS pueda pedirlo, y que un fallo del provisioner NO mueva el
 * hito del equipo.
 */
describe('Provisioning en el broker (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let cps: string; // ADMIN de CPS
  let moni: string; // MONITOR de CPS
  let ana: string; // ADMIN de la organización
  let barrioId: number;
  let boardModelId: number;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Un equipo instalado, listo para pedirle cosas. */
  async function crearEquipo(mac: string, seq: number): Promise<number> {
    const filas = await dataSource.query<{ id: number }[]>(
      `INSERT INTO device (serial, mac, type, status, board_model_id, board_seq,
                           neighborhood_id, latitude, longitude)
       VALUES ($1,$2,'COMMUNITY_ALARM','OPERATIONAL',$3,$4,$5,-31.42,-64.18)
       RETURNING id`,
      ['AV-' + mac, mac, boardModelId, seq, barrioId],
    );
    return filas[0].id;
  }

  async function colaDe(deviceId: number) {
    return dataSource.query<
      { id: string; op: string; estado: string; detalle: string | null }[]
    >(
      `SELECT id, op, estado, detalle FROM gtd.provisioning_queue
        WHERE device_id = $1 ORDER BY id`,
      [deviceId],
    );
  }

  beforeAll(async () => {
    app = await crearApp();
    dataSource = app.get(DataSource);

    await dataSource.query(`
      TRUNCATE remote_code, remote, device_maintenance, device, service_contract,
               home, neighborhood, account_user, account, user_token,
               refresh_token, app_user, locality, department, province, audit_log
      RESTART IDENTITY CASCADE
    `);
    await dataSource.query(`TRUNCATE gtd.provisioning_queue RESTART IDENTITY`);

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
    const [orgA] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO account (name, type, subtype, status, jurisdiction_level,
                            locality_id, latitude, longitude, max_neighborhoods,
                            max_admin_users, max_technician_users,
                            max_monitor_users, max_family_members,
                            community_scope_enabled)
       VALUES ('Municipalidad de Córdoba','ORGANIZATION','MUNICIPAL','ACTIVE',
               'LOCALITY',$1,-31.42,-64.18,10,5,5,5,4,true)
       RETURNING id`,
      [loc.id],
    );

    const usuario = async (
      nombre: string,
      username: string,
      accountId: number,
      rol: UserRole,
    ): Promise<void> => {
      const [u] = await dataSource.query<{ id: number }[]>(
        `INSERT INTO app_user (name, username, password_hash, status)
         VALUES ($1,$2,$3,'ACTIVE') RETURNING id`,
        [nombre, username, hash],
      );
      await dataSource.query(
        `INSERT INTO account_user (account_id, user_id, role) VALUES ($1,$2,$3)`,
        [accountId, u.id, rol],
      );
    };
    await usuario('Admin CPS', 'admin', cpsAcc.id, UserRole.ADMIN);
    await usuario('Moni Monitor', 'moni', cpsAcc.id, UserRole.MONITOR);
    await usuario('Ana Admin', 'ana', orgA.id, UserRole.ADMIN);

    const [barrio] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO neighborhood (name, code, locality_id, latitude, longitude,
                                 organization_id, organization_type, managed_by,
                                 max_family_members, community_scope_enabled, status)
       VALUES ('Barrio Jardín','JARDIN',$1,-31.42,-64.18,$2,'ORGANIZATION',
               'ORGANIZATION',4,true,'ACTIVE')
       RETURNING id`,
      [loc.id, orgA.id],
    );
    barrioId = barrio.id;

    // board_model NO se trunca arriba (sobrevive entre suites): idempotente.
    const [bm] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO board_model (code, name) VALUES ('ALOY','Aloy')
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
    );
    boardModelId = bm.id;

    cps = await login(app, 'admin');
    moni = await login(app, 'moni');
    ana = await login(app, 'ana');
  });

  afterAll(async () => {
    await app.close();
  });

  // ── El alta de fábrica ──────────────────────────────────────────────

  it('el alta de fábrica encola un provision sola', async () => {
    const res = await api(app)
      .post('/api/devices')
      .set(auth(cps))
      .send({ mac: 'AA:BB:CC:DD:EE:10', boardNumber: 'ALOY0010' })
      .expect(201);

    const id = (res.body as { id: number }).id;
    const cola = await colaDe(id);
    expect(cola).toHaveLength(1);
    expect(cola[0].op).toBe('provision');
    expect(cola[0].estado).toBe('pending');
  });

  it('la ficha muestra el estado de la cola', async () => {
    const alta = await api(app)
      .post('/api/devices')
      .set(auth(cps))
      .send({ mac: 'AA:BB:CC:DD:EE:11', boardNumber: 'ALOY0011' })
      .expect(201);
    const id = (alta.body as { id: number }).id;

    const res = await api(app)
      .get(`/api/devices/${id}`)
      .set(auth(cps))
      .expect(200);

    const body = res.body as {
      provisioning: {
        brokerRegistered: boolean;
        queue: { op: string; estado: string } | null;
      };
    };
    expect(body.provisioning.queue?.op).toBe('provision');
    expect(body.provisioning.queue?.estado).toBe('pending');
    expect(body.provisioning.brokerRegistered).toBe(false);
  });

  // ── Pedidos manuales ────────────────────────────────────────────────

  it('pedir provision dos veces no encola dos filas', async () => {
    const id = await crearEquipo('AABBCCDDEE12', 12);

    await api(app).post(`/api/devices/${id}/provision`).set(auth(cps)).expect(201);
    await api(app).post(`/api/devices/${id}/provision`).set(auth(cps)).expect(201);

    const cola = await colaDe(id);
    expect(cola.filter((f) => f.estado === 'pending')).toHaveLength(1);
  });

  it('revoke encola una fila op=revoke', async () => {
    const id = await crearEquipo('AABBCCDDEE13', 13);
    await api(app)
      .post(`/api/devices/${id}/revoke-credential`)
      .set(auth(cps))
      .expect(201);

    const cola = await colaDe(id);
    expect(cola).toHaveLength(1);
    expect(cola[0].op).toBe('revoke');
  });

  // ── Permisos ────────────────────────────────────────────────────────

  it('la organización no puede pedir el alta: es infraestructura del broker', async () => {
    const id = await crearEquipo('AABBCCDDEE14', 14);
    await api(app).post(`/api/devices/${id}/provision`).set(auth(ana)).expect(403);
  });

  it('el MONITOR de CPS tampoco', async () => {
    const id = await crearEquipo('AABBCCDDEE15', 15);
    await api(app).post(`/api/devices/${id}/provision`).set(auth(moni)).expect(403);
  });

  it('la organización tampoco puede revocar', async () => {
    const id = await crearEquipo('AABBCCDDEE16', 16);
    await api(app)
      .post(`/api/devices/${id}/revoke-credential`)
      .set(auth(ana))
      .expect(403);
  });

  // ── El ciclo completo, simulando al provisioner ─────────────────────

  it('confirmar el alta escribe el hito y deja audit_log', async () => {
    const id = await crearEquipo('AABBCCDDEE17', 17);
    await api(app).post(`/api/devices/${id}/provision`).set(auth(cps)).expect(201);
    const [fila] = await colaDe(id);

    // El provisioner confirma.
    await dataSource.query(`SELECT gtd.confirm_provisioning($1,'ok')`, [fila.id]);

    const res = await api(app)
      .get(`/api/devices/${id}`)
      .set(auth(cps))
      .expect(200);
    const body = res.body as {
      provisioning: { brokerRegistered: boolean; queue: { estado: string } | null };
    };
    expect(body.provisioning.brokerRegistered).toBe(true);
    expect(body.provisioning.queue?.estado).toBe('done');

    const audit = await dataSource.query<{ n: string }[]>(
      `SELECT count(1) AS n FROM audit_log
        WHERE action = 'device.broker.provision' AND entity_id = $1`,
      [String(id)],
    );
    expect(Number(audit[0].n)).toBeGreaterThan(0);
  });

  it('confirmar con error NO toca el equipo', async () => {
    const id = await crearEquipo('AABBCCDDEE18', 18);
    await api(app).post(`/api/devices/${id}/provision`).set(auth(cps)).expect(201);
    const [fila] = await colaDe(id);

    await dataSource.query(
      `SELECT gtd.confirm_provisioning($1,'error','el salt no reproduce el vector')`,
      [fila.id],
    );

    const cola = await colaDe(id);
    expect(cola[0].estado).toBe('failed');
    expect(cola[0].detalle).toContain('vector');

    // Lo importante: el hito NO se movió. El equipo sigue sin credencial.
    const dev = await dataSource.query<{ provisionado: boolean }[]>(
      `SELECT (mqtt_provisioned_at IS NOT NULL) AS provisionado FROM device WHERE id = $1`,
      [id],
    );
    expect(dev[0].provisionado).toBe(false);
  });

  it('un revoke confirmado borra el hito', async () => {
    const id = await crearEquipo('AABBCCDDEE19', 19);
    await api(app).post(`/api/devices/${id}/provision`).set(auth(cps)).expect(201);
    let [fila] = await colaDe(id);
    await dataSource.query(`SELECT gtd.confirm_provisioning($1,'ok')`, [fila.id]);

    await api(app)
      .post(`/api/devices/${id}/revoke-credential`)
      .set(auth(cps))
      .expect(201);
    const cola = await colaDe(id);
    fila = cola[cola.length - 1];
    await dataSource.query(`SELECT gtd.confirm_provisioning($1,'ok')`, [fila.id]);

    const dev = await dataSource.query<{ provisionado: boolean }[]>(
      `SELECT (mqtt_provisioned_at IS NOT NULL) AS provisionado FROM device WHERE id = $1`,
      [id],
    );
    expect(dev[0].provisionado).toBe(false);
  });
});
