import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PasswordService } from '../src/auth/password.service';
import { UserRole } from '../src/common/enums';
import { CODE_MAX, CODE_MIN } from '../src/remotes/remote-codes';
import { CLAVE, api, crearApp, login } from './helpers';

/**
 * Fábrica de controles remotos — integración contra la base real.
 *
 * Siembra su propio fixture v2 (no usa `sembrar()`, que sigue armando el modelo
 * v1). Lo que importa probar acá es la ATOMICIDAD del alta y la UNICIDAD de los
 * códigos: un control a medio fabricar es un llavero que no hace nada, y dos
 * controles con el mismo código son una alarma atribuida a la casa equivocada.
 */
describe('Fábrica de controles (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let cps: string; // ADMIN de CPS
  let dueno: string; // OWNER de CPS — el único que borra definitivamente
  let ana: string; // ADMIN de una organización
  let modeloCr4: number;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

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
      `INSERT INTO account (name, type, status) VALUES ('CPS Security','COMPANY','ACTIVE') RETURNING id`,
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
               -31.42,-64.18, 10, 5, 5, 5, 4, true)
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

    // El OWNER institucional de CPS. `uq_account_single_owner` deja uno solo.
    const [ownerUser] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO app_user (name, username, password_hash, status, kind)
       VALUES ('CPS Owner','cps_root',$1,'ACTIVE','INSTITUTIONAL') RETURNING id`,
      [hash],
    );
    await dataSource.query(
      `INSERT INTO account_user (account_id, user_id, role) VALUES ($1,$2,'OWNER')`,
      [cpsAcc.id, ownerUser.id],
    );

    cps = await login(app, 'admin');
    dueno = await login(app, 'cps_root');
    ana = await login(app, 'ana');

    const [cr4] = await dataSource.query<{ id: number }[]>(
      `SELECT id FROM remote_model WHERE code = 'CR4'`,
    );
    modeloCr4 = cr4.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ── El catálogo ────────────────────────────────────────────────────

  it('el catálogo nace con el modelo de 4 botones', async () => {
    const res = await api(app).get('/api/remotes/models').set(auth(cps)).expect(200);
    const modelos = res.body as { code: string; buttons: number }[];
    expect(modelos).toHaveLength(1);
    expect(modelos[0]).toMatchObject({ code: 'CR4', buttons: 4 });
  });

  it('solo CPS toca el catálogo', async () => {
    await api(app)
      .post('/api/remotes/models')
      .set(auth(ana))
      .send({ code: 'CR2', name: 'Control de 2', buttons: 2 })
      .expect(403);
  });

  // ── Fabricar ───────────────────────────────────────────────────────

  it('fabricar genera serial correlativo, modelo y los 4 códigos', async () => {
    const res = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4 })
      .expect(201);

    const control = res.body as {
      serial: string;
      modelo: { code: string };
      codigos: { position: number; codigo: number; boton: string; modo: string }[];
    };

    expect(control.serial).toBe('CR-000001');
    expect(control.modelo.code).toBe('CR4');
    expect(control.codigos).toHaveLength(4);

    // Cada código adentro del rango del panel, y cada posición con su modo.
    for (const c of control.codigos) {
      expect(c.codigo).toBeGreaterThanOrEqual(CODE_MIN);
      expect(c.codigo).toBeLessThanOrEqual(CODE_MAX);
    }
    expect(control.codigos.map((c) => c.modo)).toEqual([
      'emergency',
      'suspicious',
      'alert',
      'off',
    ]);
  });

  it('el serial avanza de a uno', async () => {
    const res = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4 })
      .expect(201);
    expect((res.body as { serial: string }).serial).toBe('CR-000002');
  });

  it('los códigos NO se guardan en claro en la base', async () => {
    const res = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4 })
      .expect(201);
    const control = res.body as { id: number; codigos: { codigo: number }[] };

    const filas = await dataSource.query<{ texto: string }[]>(
      `SELECT encode(code_encrypted,'escape') AS texto FROM remote_code WHERE remote_id = $1`,
      [control.id],
    );
    const todo = filas.map((f) => f.texto).join('|');
    for (const c of control.codigos) {
      expect(todo).not.toContain(String(c.codigo));
    }
  });

  it('el alta queda en audit_log SIN los códigos', async () => {
    const res = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4 })
      .expect(201);
    const control = res.body as { id: number; codigos: { codigo: number }[] };

    const [fila] = await dataSource.query<{ new_value: Record<string, unknown> }[]>(
      `SELECT new_value FROM audit_log
        WHERE action = 'remote.manufacture' AND entity_id = $1`,
      [String(control.id)],
    );
    expect(fila.new_value).toMatchObject({ codigos: 4 });
    // El audit_log se lee sin ceremonia: ahí no van los secretos.
    expect(JSON.stringify(fila.new_value)).not.toContain(
      String(control.codigos[0].codigo),
    );
  });

  it('una organización no fabrica', async () => {
    await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(ana))
      .send({ modelId: modeloCr4 })
      .expect(403);
  });

  it('un modelo que no existe devuelve 404', async () => {
    await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: 9999 })
      .expect(404);
  });

  // ── Códigos cargados a mano ────────────────────────────────────────

  it('se pueden cargar los 4 a mano', async () => {
    const codigos = [111111, 222222, 333333, 444444];
    const res = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4, codigos })
      .expect(201);

    expect(
      (res.body as { codigos: { codigo: number }[] }).codigos.map((c) => c.codigo),
    ).toEqual(codigos);
  });

  it('cargar de a medias devuelve 400: o todos, o ninguno', async () => {
    const res = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4, codigos: [555555, 666666] })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('4');
  });

  it('un código fuera del rango del panel devuelve 400', async () => {
    await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4, codigos: [1, 2, 3, 4] })
      .expect(400);
  });

  // ── La unicidad, que es el punto ───────────────────────────────────

  it('un código repetido DENTRO del mismo control se rechaza', async () => {
    const res = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4, codigos: [777777, 777777, 888888, 999999] })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('repetido');
  });

  it('un código que ya tiene OTRO control se rechaza, sin decir cuál', async () => {
    const res = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4, codigos: [111111, 121212, 131313, 141414] })
      .expect(409);

    const cuerpo = JSON.stringify(res.body);
    expect(cuerpo).toContain('111111');
    expect(cuerpo).toContain('otro control');
    // No se filtra de QUIÉN es: cargar códigos no puede ser una forma de sondear.
    expect(cuerpo).not.toContain('CR-0000');
  });

  it('el control rechazado NO queda a medias: la transacción se revierte', async () => {
    const [{ antes }] = await dataSource.query<{ antes: string }[]>(
      `SELECT count(1) AS antes FROM remote`,
    );

    await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4, codigos: [222222, 232323, 242424, 252525] })
      .expect(409);

    const [{ despues }] = await dataSource.query<{ despues: string }[]>(
      `SELECT count(1) AS despues FROM remote`,
    );
    // Ni un control huérfano ni un serial quemado a medias.
    expect(despues).toBe(antes);
  });

  // ── Numeración correlativa ─────────────────────────────────────────

  it('correlativo emite números seguidos', async () => {
    await dataSource.query(`ALTER SEQUENCE remote_code_seq RESTART WITH 500000`);

    const res = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4, correlativo: true })
      .expect(201);

    expect(
      (res.body as { codigos: { codigo: number }[] }).codigos.map((c) => c.codigo),
    ).toEqual([500000, 500001, 500002, 500003]);
  });

  it('el siguiente control sigue donde quedó el anterior', async () => {
    const res = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4, correlativo: true })
      .expect(201);

    expect(
      (res.body as { codigos: { codigo: number }[] }).codigos.map((c) => c.codigo),
    ).toEqual([500004, 500005, 500006, 500007]);
  });

  it('saltea los números que ya tenga otro control', async () => {
    // Alguien ya se llevó tres de los que vienen. La numeración los pasa por
    // arriba en vez de fallar: en correlativo los ocupados están todos juntos.
    await dataSource.query(`ALTER SEQUENCE remote_code_seq RESTART WITH 600000`);
    await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4, codigos: [600001, 600002, 600003, 600009] })
      .expect(201);

    const res = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4, correlativo: true })
      .expect(201);

    const codigos = (res.body as { codigos: { codigo: number }[] }).codigos.map(
      (c) => c.codigo,
    );
    expect(codigos).toEqual([600000, 600004, 600005, 600006]);
  });

  it('correlativo tampoco repite adentro del mismo control', async () => {
    await dataSource.query(`ALTER SEQUENCE remote_code_seq RESTART WITH 700000`);
    const res = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4, correlativo: true })
      .expect(201);

    const codigos = (res.body as { codigos: { codigo: number }[] }).codigos.map(
      (c) => c.codigo,
    );
    expect(new Set(codigos).size).toBe(4);
  });

  it('sin la tilde los códigos NO son correlativos', async () => {
    const res = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4 })
      .expect(201);

    const codigos = (res.body as { codigos: { codigo: number }[] }).codigos.map(
      (c) => c.codigo,
    );
    // Cuatro sorteos seguidos en 10^12 valores no van a caer consecutivos.
    expect(codigos[1] - codigos[0]).not.toBe(1);
  });

  it('el alta ya no acepta apodo: en fábrica se trabaja por serial', async () => {
    // Rechazado, no ignorado en silencio: si alguien todavía manda `name`, se
    // entera de que ese campo no existe más acá.
    await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4, name: 'Llavero cocina' })
      .expect(400);
  });

  it('el control fabricado nace SIN nombre', async () => {
    const res = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4 })
      .expect(201);

    const [fila] = await dataSource.query<{ name: string | null }[]>(
      `SELECT name FROM remote WHERE id = $1`,
      [(res.body as { id: number }).id],
    );
    // El apodo lo pone la familia cuando el control llega a una casa.
    expect(fila.name).toBeNull();
  });

  // ── El visto bueno: fabricar no es estar listo ─────────────────────

  it('un control recién fabricado NO está listo y NO entra al stock', async () => {
    const alta = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4 })
      .expect(201);
    const id = (alta.body as { id: number }).id;

    const enFabrica = await api(app)
      .get('/api/remotes/manufactured')
      .set(auth(cps))
      .expect(200);
    expect(
      (enFabrica.body as { id: number; readyAt: string | null }[]).find(
        (r) => r.id === id,
      )?.readyAt,
    ).toBeNull();

    // Está en INVENTORY —el CHECK de custodia lo exige— pero el stock no lo ve.
    const stock = await api(app)
      .get('/api/remotes/inventory')
      .set(auth(cps))
      .expect(200);
    expect((stock.body as { id: number }[]).some((r) => r.id === id)).toBe(false);
  });

  it('con el visto bueno entra al stock', async () => {
    const alta = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4 })
      .expect(201);
    const id = (alta.body as { id: number }).id;

    const marcado = await api(app)
      .post(`/api/remotes/${id}/ready`)
      .set(auth(cps))
      .send({ listo: true })
      .expect(201);
    expect((marcado.body as { readyAt: string | null }).readyAt).not.toBeNull();

    const stock = await api(app)
      .get('/api/remotes/inventory')
      .set(auth(cps))
      .expect(200);
    expect((stock.body as { id: number }[]).some((r) => r.id === id)).toBe(true);
  });

  it('el visto bueno se puede revertir, y vuelve a salir del stock', async () => {
    const alta = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4 })
      .expect(201);
    const id = (alta.body as { id: number }).id;

    await api(app)
      .post(`/api/remotes/${id}/ready`)
      .set(auth(cps))
      .send({ listo: true })
      .expect(201);
    const revertido = await api(app)
      .post(`/api/remotes/${id}/ready`)
      .set(auth(cps))
      .send({ listo: false })
      .expect(201);
    expect((revertido.body as { readyAt: string | null }).readyAt).toBeNull();

    const stock = await api(app)
      .get('/api/remotes/inventory')
      .set(auth(cps))
      .expect(200);
    expect((stock.body as { id: number }[]).some((r) => r.id === id)).toBe(false);
  });

  it('marcar y desmarcar quedan las dos en audit_log', async () => {
    const alta = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4 })
      .expect(201);
    const id = (alta.body as { id: number }).id;

    await api(app).post(`/api/remotes/${id}/ready`).set(auth(cps)).send({}).expect(201);
    await api(app)
      .post(`/api/remotes/${id}/ready`)
      .set(auth(cps))
      .send({ listo: false })
      .expect(201);

    const filas = await dataSource.query<{ action: string }[]>(
      `SELECT action FROM audit_log WHERE entity_type = 'remote' AND entity_id = $1
        AND action IN ('remote.ready','remote.ready_undo') ORDER BY id`,
      [String(id)],
    );
    expect(filas.map((f) => f.action)).toEqual([
      'remote.ready',
      'remote.ready_undo',
    ]);
  });

  it('el visto bueno es solo de CPS', async () => {
    const alta = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4 })
      .expect(201);

    await api(app)
      .post(`/api/remotes/${(alta.body as { id: number }).id}/ready`)
      .set(auth(ana))
      .send({})
      .expect(403);
  });

  it('el registro de fábrica lista todo lo fabricado, sin códigos', async () => {
    const res = await api(app)
      .get('/api/remotes/manufactured')
      .set(auth(cps))
      .expect(200);

    const rs = res.body as { serial: string }[];
    expect(rs.length).toBeGreaterThan(1);
    // Todos con serial: los anteriores a la fábrica no ensucian la lista.
    expect(rs.every((r) => r.serial?.startsWith('CR-'))).toBe(true);
    expect(JSON.stringify(rs)).not.toContain('codigo');
  });

  // ── Buscador ───────────────────────────────────────────────────────

  it('encuentra por número de serie, entero o por parte', async () => {
    const alta = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4 })
      .expect(201);
    const serial = (alta.body as { serial: string }).serial;

    for (const q of [serial, serial.replace('CR-', '')]) {
      const res = await api(app)
        .get('/api/remotes/search')
        .query({ q })
        .set(auth(cps))
        .expect(200);
      const rs = res.body as { serial: string; coincidePor: string }[];
      expect(rs.some((r) => r.serial === serial)).toBe(true);
      expect(rs[0].coincidePor).toBe('serial');
    }
  });

  it('encuentra por código y dice QUÉ BOTÓN es', async () => {
    const alta = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4, codigos: [810001, 810002, 810003, 810004] })
      .expect(201);
    const serial = (alta.body as { serial: string }).serial;

    const res = await api(app)
      .get('/api/remotes/search')
      .query({ q: '810003' })
      .set(auth(cps))
      .expect(200);

    const rs = res.body as {
      serial: string;
      coincidePor: string;
      boton: string;
      position: number;
    }[];
    expect(rs).toHaveLength(1);
    expect(rs[0].serial).toBe(serial);
    expect(rs[0].coincidePor).toBe('codigo');
    expect(rs[0].position).toBe(3);
    expect(rs[0].boton).toBe('C');
  });

  it('la búsqueda NUNCA devuelve códigos', async () => {
    await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4, codigos: [820001, 820002, 820003, 820004] })
      .expect(201);

    const res = await api(app)
      .get('/api/remotes/search')
      .query({ q: '820001' })
      .set(auth(cps))
      .expect(200);

    // El que buscó ya tiene ese número; los otros tres no tienen por qué salir
    // por un endpoint sin auditar, al lado del que sí lo está (/label).
    const cuerpo = JSON.stringify(res.body);
    expect(cuerpo).not.toContain('820002');
    expect(cuerpo).not.toContain('820001');
  });

  it('un código parcial no encuentra nada: la búsqueda es exacta', async () => {
    await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4, codigos: [830001, 830002, 830003, 830004] })
      .expect(201);

    // Con el HMAC no hay prefijos ni rangos: o sabés el número, o no está.
    const res = await api(app)
      .get('/api/remotes/search')
      .query({ q: '83000' })
      .set(auth(cps))
      .expect(200);
    expect(res.body).toEqual([]);
  });

  it('una búsqueda vacía no devuelve la flota entera', async () => {
    const res = await api(app)
      .get('/api/remotes/search')
      .query({ q: '   ' })
      .set(auth(cps))
      .expect(200);
    expect(res.body).toEqual([]);
  });

  it('el buscador es solo de CPS', async () => {
    await api(app)
      .get('/api/remotes/search')
      .query({ q: 'CR-' })
      .set(auth(ana))
      .expect(403);
  });

  // ── Papelera ───────────────────────────────────────────────────────

  /** Fabrica uno y devuelve su id y su serial. */
  async function fabricar(codigos?: number[]): Promise<{ id: number; serial: string }> {
    const res = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4, ...(codigos ? { codigos } : {}) })
      .expect(201);
    return res.body as { id: number; serial: string };
  }

  it('remover lo saca del registro y lo pone en la papelera', async () => {
    const control = await fabricar();

    await api(app)
      .post(`/api/remotes/${control.id}/remove`)
      .set(auth(cps))
      .expect(201);

    const fabrica = await api(app)
      .get('/api/remotes/manufactured')
      .set(auth(cps))
      .expect(200);
    expect((fabrica.body as { id: number }[]).some((r) => r.id === control.id)).toBe(
      false,
    );

    const papelera = await api(app)
      .get('/api/remotes/removed')
      .set(auth(cps))
      .expect(200);
    expect((papelera.body as { id: number }[]).some((r) => r.id === control.id)).toBe(
      true,
    );
  });

  it('un control removido tampoco está en el stock, aunque estuviera listo', async () => {
    const control = await fabricar();
    await api(app)
      .post(`/api/remotes/${control.id}/ready`)
      .set(auth(cps))
      .send({})
      .expect(201);
    await api(app)
      .post(`/api/remotes/${control.id}/remove`)
      .set(auth(cps))
      .expect(201);

    const stock = await api(app)
      .get('/api/remotes/inventory')
      .set(auth(cps))
      .expect(200);
    expect((stock.body as { id: number }[]).some((r) => r.id === control.id)).toBe(
      false,
    );
  });

  it('remover dos veces devuelve 409', async () => {
    const control = await fabricar();
    await api(app).post(`/api/remotes/${control.id}/remove`).set(auth(cps)).expect(201);
    await api(app).post(`/api/remotes/${control.id}/remove`).set(auth(cps)).expect(409);
  });

  it('restaurar lo devuelve al registro, pero SIN el visto bueno', async () => {
    const control = await fabricar();
    await api(app)
      .post(`/api/remotes/${control.id}/ready`)
      .set(auth(cps))
      .send({})
      .expect(201);
    await api(app).post(`/api/remotes/${control.id}/remove`).set(auth(cps)).expect(201);

    const vuelto = await api(app)
      .post(`/api/remotes/${control.id}/restore`)
      .set(auth(cps))
      .expect(201);

    // Pasó por la papelera: alguien tiene que mirarlo de nuevo antes de que
    // se lo pueda entregar.
    expect((vuelto.body as { readyAt: string | null }).readyAt).toBeNull();
    expect((vuelto.body as { removedAt: string | null }).removedAt).toBeNull();

    const stock = await api(app)
      .get('/api/remotes/inventory')
      .set(auth(cps))
      .expect(200);
    expect((stock.body as { id: number }[]).some((r) => r.id === control.id)).toBe(
      false,
    );
  });

  it('la papelera es solo de CPS', async () => {
    await api(app).get('/api/remotes/removed').set(auth(ana)).expect(403);
  });

  // ── Borrado definitivo ─────────────────────────────────────────────

  it('no se puede borrar sin pasar antes por la papelera', async () => {
    const control = await fabricar();
    const res = await api(app)
      .delete(`/api/remotes/${control.id}`)
      .set(auth(dueno))
      .expect(409);
    expect(JSON.stringify(res.body)).toContain('papelera');
  });

  it('borrar definitivamente se lleva el control y sus códigos', async () => {
    const control = await fabricar();
    await api(app).post(`/api/remotes/${control.id}/remove`).set(auth(cps)).expect(201);

    await api(app).delete(`/api/remotes/${control.id}`).set(auth(dueno)).expect(200);

    const [{ n }] = await dataSource.query<{ n: string }[]>(
      `SELECT count(1) AS n FROM remote_code WHERE remote_id = $1`,
      [control.id],
    );
    expect(Number(n)).toBe(0);
  });

  it('el borrado queda en audit_log con el serial que se llevó', async () => {
    const control = await fabricar();
    await api(app).post(`/api/remotes/${control.id}/remove`).set(auth(cps)).expect(201);
    await api(app).delete(`/api/remotes/${control.id}`).set(auth(dueno)).expect(200);

    const [fila] = await dataSource.query<{ old_value: { serial: string } }[]>(
      `SELECT old_value FROM audit_log
        WHERE action = 'remote.hard_delete' AND entity_id = $1`,
      [String(control.id)],
    );
    // `entity_id` no tiene FK: la fila sobrevive al control borrado.
    expect(fila.old_value.serial).toBe(control.serial);
  });

  /**
   * Lo que pidió el usuario: al borrar definitivamente, esos números vuelven a
   * estar disponibles.
   *
   * Sale solo del diseño y no hay código que lo haga: la reserva vive en el
   * índice único sobre `code_hmac`, así que cuando el CASCADE se lleva las filas
   * se va la reserva con ellas.
   */
  it('al borrar, sus códigos VUELVEN A ESTAR DISPONIBLES', async () => {
    const codigos = [910001, 910002, 910003, 910004];
    const control = await fabricar(codigos);

    // Mientras existe, nadie más los puede usar.
    await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4, codigos })
      .expect(409);

    await api(app).post(`/api/remotes/${control.id}/remove`).set(auth(cps)).expect(201);
    await api(app).delete(`/api/remotes/${control.id}`).set(auth(dueno)).expect(200);

    // Borrado el control, los mismos cuatro números entran de nuevo.
    const nuevo = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4, codigos })
      .expect(201);
    expect(
      (nuevo.body as { codigos: { codigo: number }[] }).codigos.map((c) => c.codigo),
    ).toEqual(codigos);
  });

  it('removerlo NO libera los códigos: sigue existiendo', async () => {
    const codigos = [920001, 920002, 920003, 920004];
    const control = await fabricar(codigos);
    await api(app).post(`/api/remotes/${control.id}/remove`).set(auth(cps)).expect(201);

    // Un control en la papelera puede volver, así que sus códigos siguen
    // reservados. Liberarlos sería poder restaurarlo con los códigos de otro.
    await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4, codigos })
      .expect(409);
  });

  it('el borrado definitivo es solo del OWNER', async () => {
    const control = await fabricar();
    await api(app).post(`/api/remotes/${control.id}/remove`).set(auth(cps)).expect(201);

    // El ADMIN de CPS puede remover pero no borrar: es la única operación del
    // módulo que destruye algo sin vuelta.
    await api(app).delete(`/api/remotes/${control.id}`).set(auth(cps)).expect(403);
    await api(app).delete(`/api/remotes/${control.id}`).set(auth(dueno)).expect(200);
  });

  it('un control con eventos NO se puede borrar', async () => {
    const control = await fabricar();
    await api(app).post(`/api/remotes/${control.id}/remove`).set(auth(cps)).expect(201);

    // Un barrio y un evento que lo referencia: los eventos son append-only.
    const [barrio] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO neighborhood (name, code, locality_id, latitude, longitude,
                                 organization_id, organization_type, managed_by,
                                 max_family_members, community_scope_enabled, status)
       SELECT 'Barrio Test','TEST', l.id, -31.42, -64.18, a.id, 'ORGANIZATION',
              'ORGANIZATION', 4, true, 'ACTIVE'
         FROM locality l, account a
        WHERE a.type = 'ORGANIZATION' LIMIT 1
       RETURNING id`,
    );
    await dataSource.query(
      `INSERT INTO event (neighborhood_id, remote_id, origin, scope)
       VALUES ($1, $2, 'REMOTE', 'SINGLE')`,
      [barrio.id, control.id],
    );

    const res = await api(app)
      .delete(`/api/remotes/${control.id}`)
      .set(auth(dueno))
      .expect(409);
    expect(JSON.stringify(res.body)).toContain('eventos');
  });

  // ── La etiqueta ────────────────────────────────────────────────────

  it('la etiqueta trae serial, modelo y los códigos, y queda auditada', async () => {
    const alta = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4 })
      .expect(201);
    const control = alta.body as { id: number; serial: string };

    const res = await api(app)
      .get(`/api/remotes/${control.id}/label`)
      .set(auth(cps))
      .expect(200);

    const etiqueta = res.body as {
      serial: string;
      modelo: { buttons: number };
      codigos: { position: number; codigo: number }[];
    };
    expect(etiqueta.serial).toBe(control.serial);
    expect(etiqueta.modelo.buttons).toBe(4);
    expect(etiqueta.codigos).toHaveLength(4);

    const filas = await dataSource.query<{ n: string }[]>(
      `SELECT count(1) AS n FROM audit_log
        WHERE action = 'remote.codes_reveal' AND entity_id = $1`,
      [String(control.id)],
    );
    expect(Number(filas[0].n)).toBe(1);
  });

  it('la etiqueta es solo de CPS', async () => {
    const alta = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: modeloCr4 })
      .expect(201);

    await api(app)
      .get(`/api/remotes/${(alta.body as { id: number }).id}/label`)
      .set(auth(ana))
      .expect(403);
  });

  it('un control anterior a la fábrica no tiene etiqueta que imprimir', async () => {
    const [viejo] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO remote (name, status) VALUES ('Control viejo','INVENTORY') RETURNING id`,
    );
    const res = await api(app)
      .get(`/api/remotes/${viejo.id}/label`)
      .set(auth(cps))
      .expect(409);
    expect(JSON.stringify(res.body)).toContain('anterior a la fábrica');
  });
});
