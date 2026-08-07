import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PasswordService } from '../src/auth/password.service';
import { UserRole } from '../src/common/enums';
import { CLAVE, api, crearApp, login } from './helpers';

/**
 * El recorrido completo de un control remoto: fábrica → stock de CPS → stock
 * del cliente → vivienda → devolución.
 *
 * Lo que importa probar acá no son los endpoints sueltos sino las TRANSICIONES:
 * que un control no salga de fábrica sin visto bueno, que no se lo pueda mover
 * de casa sin devolverlo, y que devolverlo lo deje listo para otra familia.
 */
describe('Flujo del control remoto (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let cps: string;
  let ana: string; // ADMIN de la municipalidad
  let ids: {
    org: number;
    otraOrg: number;
    barrio: number;
    casa: number;
    otraCasa: number;
    vecino: number;
    otroVecino: number;
    ajeno: number; // miembro de OTRA casa
    modelo: number;
  };

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** El listado devuelve una página, no un array: son ~12.000 controles. */
  interface ControlDeLista {
    id: number;
    serial: string | null;
    home: { id: number; address: string } | null;
    assignedToUser: { id: number; name: string; dni: string | null } | null;
  }
  const pagina = (body: unknown) =>
    body as {
      items: ControlDeLista[];
      total: number;
      limit: number;
      offset: number;
    };

  /**
   * Un vecino RECIÉN CREADO de una casa, con su DNI.
   *
   * Desde que una persona lleva un solo control (`uq_remote_one_per_carrier`),
   * cada entrega necesita un portador libre: reusar a Juan en dos tests dejaba
   * el segundo chocando contra el control que le entregó el primero.
   */
  let nVecinos = 0;
  async function vecinoLibre(
    casa?: number,
  ): Promise<{ id: number; dni: string; name: string }> {
    nVecinos++;
    const dni = String(21000000 + nVecinos);
    const name = `Vecino Suplente ${nVecinos}`;
    const [u] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO app_user (name, dni, status) VALUES ($1,$2,'ACTIVE') RETURNING id`,
      [name, dni],
    );
    await dataSource.query(
      `INSERT INTO home_member (home_id, user_id, role, status)
       VALUES ($1,$2,'FAMILIAR','ACTIVE')`,
      [casa ?? ids.casa, u.id],
    );
    return { id: u.id, dni, name };
  }

  /** Fabrica uno y le da el visto bueno: listo para entregar. */
  async function fabricarListo(): Promise<{
    id: number;
    serial: string;
    claimCode: string;
  }> {
    const res = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: ids.modelo })
      .expect(201);
    const control = res.body as {
      id: number;
      serial: string;
      claimCode: string;
    };
    await api(app)
      .post(`/api/remotes/${control.id}/ready`)
      .set(auth(cps))
      .send({})
      .expect(201);
    return control;
  }

  beforeAll(async () => {
    app = await crearApp();
    dataSource = app.get(DataSource);

    await dataSource.query(`
      TRUNCATE remote_code, remote, device_maintenance, device, service_contract,
               home_member, home, neighborhood, account_user, account, user_token,
               refresh_token, app_user, locality, department, province, audit_log
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

    const org = async (nombre: string): Promise<number> => {
      const [a] = await dataSource.query<{ id: number }[]>(
        `INSERT INTO account (name, type, subtype, status, jurisdiction_level, locality_id,
                              latitude, longitude, max_neighborhoods, max_admin_users,
                              max_technician_users, max_monitor_users, max_family_members,
                              community_scope_enabled)
         VALUES ($1,'ORGANIZATION','MUNICIPAL','ACTIVE','LOCALITY',$2,
                 -31.42,-64.18, 10, 5, 5, 5, 4, true)
         RETURNING id`,
        [nombre, loc.id],
      );
      return a.id;
    };
    const orgId = await org('Municipalidad de Córdoba');
    const otraOrgId = await org('Municipalidad de Río Cuarto');

    const [anaUser] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO app_user (name, username, password_hash, status)
       VALUES ('Ana Admin','ana',$1,'ACTIVE') RETURNING id`,
      [hash],
    );
    await dataSource.query(
      `INSERT INTO account_user (account_id, user_id, role) VALUES ($1,$2,$3)`,
      [orgId, anaUser.id, UserRole.ADMIN],
    );

    const [barrio] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO neighborhood (name, code, locality_id, latitude, longitude,
                                 organization_id, organization_type, managed_by,
                                 max_family_members, community_scope_enabled, status)
       VALUES ('Barrio Jardín','JARDIN',$1,-31.42,-64.18,$2,'ORGANIZATION',
               'ORGANIZATION',80,true,'ACTIVE')
       RETURNING id`,
      [loc.id, orgId],
    );

    /** Una vivienda con su titular y, opcionalmente, un familiar. */
    const casaCon = async (
      direccion: string,
      titular: string,
      dni: string,
    ): Promise<{ casa: number; vecino: number }> => {
      const [h] = await dataSource.query<{ id: number }[]>(
        `INSERT INTO home (address, neighborhood_id, latitude, longitude, status)
         VALUES ($1,$2,-31.42,-64.18,'ACTIVE') RETURNING id`,
        [direccion, barrio.id],
      );
      const [u] = await dataSource.query<{ id: number }[]>(
        `INSERT INTO app_user (name, dni, status) VALUES ($1,$2,'ACTIVE') RETURNING id`,
        [titular, dni],
      );
      await dataSource.query(
        `INSERT INTO home_member (home_id, user_id, role, status)
         VALUES ($1,$2,'TITULAR','ACTIVE')`,
        [h.id, u.id],
      );
      return { casa: h.id, vecino: u.id };
    };

    const casaUno = await casaCon('Belgrano 123', 'Juan Pérez', '20111222');
    const casaDos = await casaCon('San Martín 456', 'Rosa Gómez', '20333444');

    // Un familiar de la primera casa: el segundo portador posible.
    const [familiar] = await dataSource.query<{ id: number }[]>(
      `INSERT INTO app_user (name, dni, status)
       VALUES ('Pedro Pérez','20555666','ACTIVE') RETURNING id`,
    );
    await dataSource.query(
      `INSERT INTO home_member (home_id, user_id, role, status)
       VALUES ($1,$2,'FAMILIAR','ACTIVE')`,
      [casaUno.casa, familiar.id],
    );

    cps = await login(app, 'admin');
    ana = await login(app, 'ana');

    const [modelo] = await dataSource.query<{ id: number }[]>(
      `SELECT id FROM remote_model WHERE code = 'CR4'`,
    );

    ids = {
      org: orgId,
      otraOrg: otraOrgId,
      barrio: barrio.id,
      casa: casaUno.casa,
      otraCasa: casaDos.casa,
      vecino: casaUno.vecino,
      otroVecino: familiar.id,
      ajeno: casaDos.vecino,
      modelo: modelo.id,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Entrega de lote ────────────────────────────────────────────────

  it('la fábrica le pone un código de reclamo a cada control', async () => {
    const control = await fabricarListo();
    // 6 caracteres del alfabeto sin 0/O ni 1/I: se dicta por teléfono.
    expect(control.claimCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });

  it('un lote pasa del stock de CPS al del municipio', async () => {
    const a = await fabricarListo();
    const b = await fabricarListo();

    const res = await api(app)
      .post('/api/remotes/deliver')
      .set(auth(cps))
      .send({ remoteIds: [a.id, b.id], organizationId: ids.org })
      .expect(201);
    expect((res.body as { delivered: number }).delivered).toBe(2);

    // La muni ahora los ve en SU stock.
    const stock = await api(app)
      .get('/api/remotes/inventory')
      .set(auth(ana))
      .expect(200);
    const suyos = (stock.body as { id: number }[]).map((r) => r.id);
    expect(suyos).toContain(a.id);
    expect(suyos).toContain(b.id);
  });

  it('no se entrega un control sin el visto bueno de fábrica', async () => {
    const alta = await api(app)
      .post('/api/remotes/manufacture')
      .set(auth(cps))
      .send({ modelId: ids.modelo })
      .expect(201);

    const res = await api(app)
      .post('/api/remotes/deliver')
      .set(auth(cps))
      .send({
        remoteIds: [(alta.body as { id: number }).id],
        organizationId: ids.org,
      })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('visto bueno');
  });

  it('una organización no entrega lotes', async () => {
    const control = await fabricarListo();
    await api(app)
      .post('/api/remotes/deliver')
      .set(auth(ana))
      .send({ remoteIds: [control.id], organizationId: ids.org })
      .expect(403);
  });

  // ── Adopción por código ────────────────────────────────────────────

  it('la muni suma un control a su stock con serial y código', async () => {
    const control = await fabricarListo();

    await api(app)
      .post('/api/remotes/adopt')
      .set(auth(ana))
      .send({ serial: control.serial, claimCode: control.claimCode })
      .expect(201);

    const stock = await api(app)
      .get('/api/remotes/inventory')
      .set(auth(ana))
      .expect(200);
    expect(
      (stock.body as { id: number }[]).some((r) => r.id === control.id),
    ).toBe(true);
  });

  it('con el código equivocado no se adopta, y el error no delata nada', async () => {
    const control = await fabricarListo();
    const res = await api(app)
      .post('/api/remotes/adopt')
      .set(auth(ana))
      .send({ serial: control.serial, claimCode: 'XXXXXX' })
      .expect(404);
    // Mismo mensaje que "no existe": si no, esto sería una forma de averiguar
    // qué seriales existen.
    expect(JSON.stringify(res.body)).toContain('serial y código');
  });

  it('un control que ya es de otra organización no se adopta', async () => {
    const control = await fabricarListo();
    await api(app)
      .post('/api/remotes/deliver')
      .set(auth(cps))
      .send({ remoteIds: [control.id], organizationId: ids.otraOrg })
      .expect(201);

    await api(app)
      .post('/api/remotes/adopt')
      .set(auth(ana))
      .send({ serial: control.serial, claimCode: control.claimCode })
      .expect(409);
  });

  // ── Asignación a una vivienda ──────────────────────────────────────

  it('asignar deja el control en la casa Y con su portador', async () => {
    const control = await fabricarListo();
    const vecino = await vecinoLibre();

    const res = await api(app)
      .post(`/api/remotes/${control.id}/assign`)
      .set(auth(cps))
      .send({ homeId: ids.casa, assignedToUserId: vecino.id })
      .expect(201);

    const asignado = res.body as {
      homeId: number;
      assignedToUserId: number;
      status: string;
      organizationId: number | null;
    };
    expect(asignado.homeId).toBe(ids.casa);
    expect(asignado.assignedToUserId).toBe(vecino.id);
    expect(asignado.status).toBe('ACTIVE');
    // Entregado: ya no es stock de nadie.
    expect(asignado.organizationId).toBeNull();
  });

  it('el portador es OBLIGATORIO', async () => {
    const control = await fabricarListo();
    await api(app)
      .post(`/api/remotes/${control.id}/assign`)
      .set(auth(cps))
      .send({ homeId: ids.casa })
      .expect(400);
  });

  it('el portador tiene que ser de ESA casa', async () => {
    const control = await fabricarListo();
    await api(app)
      .post(`/api/remotes/${control.id}/assign`)
      .set(auth(cps))
      .send({ homeId: ids.casa, assignedToUserId: ids.ajeno })
      .expect(400);
  });

  /**
   * UNA PERSONA, UN CONTROL. No es una preferencia de la web: la base del panel
   * se indexa por DNI y guarda un registro por persona, así que el segundo
   * control del mismo portador nunca podría cargarse en el equipo.
   */
  it('una persona no puede llevar dos controles', async () => {
    const vecino = await vecinoLibre();
    const primero = await fabricarListo();
    const segundo = await fabricarListo();

    await api(app)
      .post(`/api/remotes/${primero.id}/assign`)
      .set(auth(cps))
      .send({ homeId: ids.casa, assignedToUserId: vecino.id })
      .expect(201);

    const res = await api(app)
      .post(`/api/remotes/${segundo.id}/assign`)
      .set(auth(cps))
      .send({ homeId: ids.casa, assignedToUserId: vecino.id })
      .expect(409);
    // El mensaje tiene que decir CUÁL es el otro control, o no se puede resolver.
    expect(JSON.stringify(res.body)).toContain(primero.serial);
  });

  it('tampoco se le pasa el portador a alguien que ya lleva uno', async () => {
    const ocupado = await vecinoLibre();
    const libre = await vecinoLibre();
    const suyo = await fabricarListo();
    const otro = await fabricarListo();

    for (const [control, quien] of [
      [suyo, ocupado],
      [otro, libre],
    ] as const) {
      await api(app)
        .post(`/api/remotes/${control.id}/assign`)
        .set(auth(cps))
        .send({ homeId: ids.casa, assignedToUserId: quien.id })
        .expect(201);
    }

    // Reasignar el de `libre` al que ya lleva el suyo: mismo choque.
    await api(app)
      .patch(`/api/remotes/${otro.id}`)
      .set(auth(cps))
      .send({ assignedToUserId: ocupado.id })
      .expect(409);

    // Pero dejarle el suyo al que ya lo tiene NO es un choque consigo mismo.
    await api(app)
      .patch(`/api/remotes/${suyo.id}`)
      .set(auth(cps))
      .send({ assignedToUserId: ocupado.id })
      .expect(200);
  });

  it('CPS puede asignar directo desde su stock, sin escala en el municipio', async () => {
    const control = await fabricarListo();
    // Nunca se entregó a nadie: sigue en fábrica.
    await api(app)
      .post(`/api/remotes/${control.id}/assign`)
      .set(auth(cps))
      .send({ homeId: ids.casa, assignedToUserId: (await vecinoLibre()).id })
      .expect(201);
  });

  it('una casa puede tener varios controles', async () => {
    // Varios controles SÍ, pero uno por persona: la casa entera comparte la
    // alarma, y la alarma guarda un registro por DNI.
    for (const c of [await fabricarListo(), await fabricarListo()]) {
      await api(app)
        .post(`/api/remotes/${c.id}/assign`)
        .set(auth(cps))
        .send({ homeId: ids.casa, assignedToUserId: (await vecinoLibre()).id })
        .expect(201);
    }

    const res = await api(app)
      .get('/api/remotes')
      .query({ homeId: ids.casa })
      .set(auth(ana))
      .expect(200);
    expect(pagina(res.body).items.length).toBeGreaterThanOrEqual(2);
  });

  it('un control ya entregado no se puede mandar a otra casa', async () => {
    const control = await fabricarListo();
    await api(app)
      .post(`/api/remotes/${control.id}/assign`)
      .set(auth(cps))
      .send({ homeId: ids.casa, assignedToUserId: (await vecinoLibre()).id })
      .expect(201);

    const res = await api(app)
      .post(`/api/remotes/${control.id}/assign`)
      .set(auth(cps))
      .send({ homeId: ids.casa, assignedToUserId: (await vecinoLibre()).id })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('devolvelo al stock');
  });

  // ── Devolución ─────────────────────────────────────────────────────

  it('devolver lo saca de la casa y lo deja en el stock del municipio', async () => {
    const control = await fabricarListo();
    await api(app)
      .post(`/api/remotes/${control.id}/assign`)
      .set(auth(cps))
      .send({ homeId: ids.casa, assignedToUserId: (await vecinoLibre()).id })
      .expect(201);

    const res = await api(app)
      .post(`/api/remotes/${control.id}/return`)
      .set(auth(ana))
      .expect(201);

    const devuelto = res.body as {
      homeId: number | null;
      assignedToUserId: number | null;
      status: string;
      organizationId: number | null;
    };
    expect(devuelto.homeId).toBeNull();
    // Sin portador: nadie lo lleva encima mientras está en el stock.
    expect(devuelto.assignedToUserId).toBeNull();
    expect(devuelto.status).toBe('INVENTORY');
    // Al stock de quien opera el barrio, no al de fábrica.
    expect(devuelto.organizationId).toBe(ids.org);
  });

  it('un control devuelto se puede asignar a OTRA casa', async () => {
    const control = await fabricarListo();
    await api(app)
      .post(`/api/remotes/${control.id}/assign`)
      .set(auth(cps))
      .send({ homeId: ids.casa, assignedToUserId: (await vecinoLibre()).id })
      .expect(201);
    await api(app)
      .post(`/api/remotes/${control.id}/return`)
      .set(auth(ana))
      .expect(201);

    // Es el punto de toda la decisión: el llavero devuelto se reutiliza.
    await api(app)
      .post(`/api/remotes/${control.id}/assign`)
      .set(auth(ana))
      .send({ homeId: ids.casa, assignedToUserId: (await vecinoLibre()).id })
      .expect(201);
  });

  it('no se devuelve un control que ya está en el stock', async () => {
    const control = await fabricarListo();
    await api(app)
      .post(`/api/remotes/${control.id}/return`)
      .set(auth(cps))
      .expect(400);
  });

  it('la devolución queda en audit_log con de dónde salió', async () => {
    const control = await fabricarListo();
    const vecino = await vecinoLibre();
    await api(app)
      .post(`/api/remotes/${control.id}/assign`)
      .set(auth(cps))
      .send({ homeId: ids.casa, assignedToUserId: vecino.id })
      .expect(201);
    await api(app)
      .post(`/api/remotes/${control.id}/return`)
      .set(auth(ana))
      .expect(201);

    const [fila] = await dataSource.query<
      { old_value: { homeId: number; assignedToUserId: number } }[]
    >(
      `SELECT old_value FROM audit_log
        WHERE action = 'remote.return' AND entity_id = $1`,
      [String(control.id)],
    );
    expect(fila.old_value.homeId).toBe(ids.casa);
    expect(fila.old_value.assignedToUserId).toBe(vecino.id);
  });

  // ── El listado de Operar: filtros, búsqueda y paginación ───────────
  //
  // Un barrio con 10 alarmas puede tener ~1200 controles y una municipal con 10
  // barrios se va a ~12.000. Lo que se prueba acá es que la pantalla pueda
  // encontrar UNO entre todos esos sin bajarse la lista entera.

  describe('listado de controles entregados', () => {
    /**
     * Fabrica, entrega a una casa y devuelve el control con su portador.
     *
     * El portador lo crea el helper: una persona lleva un solo control, así que
     * compartir a Juan entre dos entregas era un 409.
     */
    async function entregarA(casa: number): Promise<{
      id: number;
      vecino: { id: number; dni: string; name: string };
    }> {
      const control = await fabricarListo();
      const vecino = await vecinoLibre(casa);
      await api(app)
        .post(`/api/remotes/${control.id}/assign`)
        .set(auth(cps))
        .send({ homeId: casa, assignedToUserId: vecino.id })
        .expect(201);
      return { id: control.id, vecino };
    }

    const listar = async (token: string, query: Record<string, unknown> = {}) =>
      pagina(
        (
          await api(app)
            .get('/api/remotes')
            .query(query)
            .set(auth(token))
            .expect(200)
        ).body,
      );

    it('el stock NO sale: esta pantalla es de los controles entregados', async () => {
      const enStock = await fabricarListo();

      const { items } = await listar(cps, { limit: 200 });
      expect(items.some((c) => c.id === enStock.id)).toBe(false);
      // Y los que sí salen, todos tienen vivienda.
      expect(items.every((c) => c.home !== null)).toBe(true);
    });

    it('un control removido desaparece del listado', async () => {
      const { id } = await entregarA(ids.casa);
      await api(app)
        .post(`/api/remotes/${id}/remove`)
        .set(auth(cps))
        .send({})
        .expect(201);

      const { items } = await listar(cps, { limit: 200 });
      expect(items.some((c) => c.id === id)).toBe(false);
    });

    it('filtra por vivienda', async () => {
      await entregarA(ids.casa);
      await entregarA(ids.otraCasa);

      const { items } = await listar(ana, { homeId: ids.otraCasa, limit: 200 });
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((c) => c.home?.id === ids.otraCasa)).toBe(true);
    });

    it('busca por DNI aunque lo escriban con puntos', async () => {
      const { vecino } = await entregarA(ids.casa);
      // El DNI se dicta con puntos y en la base va limpio.
      const conPuntos = vecino.dni.replace(
        /^(\d{2})(\d{3})(\d{3})$/,
        '$1.$2.$3',
      );

      const { items } = await listar(ana, { q: conPuntos });
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((c) => c.assignedToUser?.dni === vecino.dni)).toBe(
        true,
      );
    });

    it('busca por dirección y por serial', async () => {
      const { id } = await entregarA(ids.otraCasa);
      const { serial } = (
        await api(app).get(`/api/remotes/${id}`).set(auth(cps)).expect(200)
      ).body as { serial: string };

      const porDireccion = await listar(ana, { q: 'san martín' });
      expect(porDireccion.items.every((c) => c.home?.id === ids.otraCasa)).toBe(
        true,
      );

      const porSerial = await listar(ana, { q: serial });
      expect(porSerial.items.map((c) => c.id)).toContain(id);
    });

    it('el filtro de cliente INTERSECTA el alcance: el ajeno da vacío', async () => {
      await entregarA(ids.casa);

      // Ana es ADMIN de la primera muni. Pedir la otra no es un 403 que confirme
      // que existe: es una página vacía.
      const otra = await listar(ana, { organizationId: ids.otraOrg });
      expect(otra.items).toHaveLength(0);
      expect(otra.total).toBe(0);

      const propia = await listar(ana, { organizationId: ids.org });
      expect(propia.total).toBeGreaterThan(0);
    });

    it('pagina: la página corta pero el total cuenta todo', async () => {
      await entregarA(ids.casa);
      await entregarA(ids.casa);
      await entregarA(ids.casa);

      const primera = await listar(ana, {
        homeId: ids.casa,
        limit: 2,
        offset: 0,
      });
      expect(primera.items).toHaveLength(2);
      expect(primera.total).toBeGreaterThan(2);

      const segunda = await listar(ana, {
        homeId: ids.casa,
        limit: 2,
        offset: 2,
      });
      expect(segunda.items.length).toBeGreaterThan(0);
      // Sin superposición: paginar no repite filas.
      const idsPrimera = primera.items.map((c) => c.id);
      expect(segunda.items.some((c) => idsPrimera.includes(c.id))).toBe(false);
    });

    it('cada fila trae dirección, barrio, cliente y portador con DNI', async () => {
      const { id, vecino } = await entregarA(ids.casa);

      const { items } = await listar(ana, { homeId: ids.casa, limit: 200 });
      const fila = items.find((c) => c.id === id) as unknown as {
        home: {
          address: string;
          neighborhood: { name: string; organization: { name: string } };
        };
        assignedToUser: { name: string; dni: string };
      };

      expect(fila.home.address).toBe('Belgrano 123');
      expect(fila.home.neighborhood.name).toBe('Barrio Jardín');
      expect(fila.home.neighborhood.organization.name).toBe(
        'Municipalidad de Córdoba',
      );
      expect(fila.assignedToUser.name).toBe(vecino.name);
      expect(fila.assignedToUser.dni).toBe(vecino.dni);
    });

    it('el portador no viaja con su hash de contraseña', async () => {
      await entregarA(ids.casa);
      const { items } = await listar(ana, { homeId: ids.casa });
      expect(JSON.stringify(items)).not.toContain('passwordHash');
    });
  });
});
