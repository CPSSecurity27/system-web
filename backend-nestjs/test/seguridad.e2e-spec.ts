import { api, Escenario, sembrar } from './helpers';

/**
 * El barrido de ataques cruzados.
 *
 * Estos tests existen porque los TRES agujeros que encontramos pasaban el caso
 * feliz sin despeinarse. La regla que codifican:
 *
 *   El ROL dice QUÉ podés hacer. La MEMBRESÍA dice SOBRE QUIÉN.
 *
 * Si alguno de estos vuelve a pasar en verde por accidente, revisá que el
 * endpoint no haya dejado de existir.
 */
describe('Seguridad — aislamiento entre cuentas', () => {
  let e: Escenario;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    e = await sembrar();
  }, 60_000);

  afterAll(async () => {
    await e.app.close();
  });

  describe('CRÍTICO: un vecino no puede tocar al admin de CPS', () => {
    it('el titular de una vivienda NO puede leer los datos del admin de CPS', () =>
      api(e.app)
        .get(`/api/users/${e.ids.cpsUser}`)
        .set(bearer(e.juan))
        .expect(403));

    it('el titular NO puede SUSPENDER al admin de CPS (dejaría al sistema sin administrador)', () =>
      api(e.app)
        .patch(`/api/users/${e.ids.cpsUser}`)
        .set(bearer(e.juan))
        .send({ status: 'SUSPENDED' })
        .expect(403));

    it('...y tampoco por el rodeo: no puede sumar al admin de CPS a su propia cuenta', () =>
      api(e.app)
        .post(`/api/accounts/${e.ids.homeAccountJuan}/members`)
        .set(bearer(e.juan))
        .send({ userId: e.ids.cpsUser, role: 'USER' })
        .expect(403));

    it('el admin de CPS sigue pudiendo entrar', () =>
      api(e.app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'ClaveDePrueba2026!' })
        .expect(200));
  });

  describe('un municipio no ve nada del otro', () => {
    it('Ana solo ve SU barrio en el listado (aunque en el sistema hay dos)', async () => {
      const res = await api(e.app)
        .get('/api/neighborhoods')
        .set(bearer(e.ana))
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect((res.body as { id: number }[])[0].id).toBe(e.ids.barrioA);
    });

    it('Ana NO puede leer el barrio de Beto', () =>
      api(e.app)
        .get(`/api/neighborhoods/${e.ids.barrioB}`)
        .set(bearer(e.ana))
        .expect(403));

    it('Ana NO puede editar el barrio de Beto', () =>
      api(e.app)
        .patch(`/api/neighborhoods/${e.ids.barrioB}`)
        .set(bearer(e.ana))
        .send({ name: 'Hackeado' })
        .expect(403));

    it('Ana NO puede meter una vivienda en el barrio de Beto', () =>
      api(e.app)
        .post('/api/homes')
        .set(bearer(e.ana))
        .send({ name: 'Casa intrusa', neighborhoodId: e.ids.barrioB })
        .expect(403));

    it('Ana NO puede ver la alarma del barrio de Beto', () =>
      api(e.app)
        .get(`/api/devices/${e.ids.alarmaB}`)
        .set(bearer(e.ana))
        .expect(403));

    it('filtrar por una localidad ajena devuelve VACÍO, no barrios ajenos', async () => {
      const res = await api(e.app)
        .get(`/api/neighborhoods?localityId=${e.ids.localidadB}`)
        .set(bearer(e.ana))
        .expect(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('un vecino no ve la casa del vecino', () => {
    it('Juan solo ve SU vivienda (hay dos en el mismo barrio)', async () => {
      const res = await api(e.app)
        .get('/api/homes')
        .set(bearer(e.juan))
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect((res.body as { id: number }[])[0].id).toBe(e.ids.casaJuan);
    });

    it('Gaby NO puede leer la vivienda de Juan', () =>
      api(e.app)
        .get(`/api/homes/${e.ids.casaJuan}`)
        .set(bearer(e.gaby))
        .expect(403));

    it('Gaby NO puede leer el control remoto de Juan', () =>
      api(e.app)
        .get(`/api/remotes/${e.ids.controlJuan}`)
        .set(bearer(e.gaby))
        .expect(403));

    it('el contrato ajeno da 404 (ni siquiera se confirma que exista)', () =>
      api(e.app)
        .get(`/api/contracts/${e.ids.contratoCasaJuan}`)
        .set(bearer(e.gaby))
        .expect(404));

    it('Ana NO puede leer la cuenta HOME de una familia de su barrio', () =>
      api(e.app)
        .get(`/api/accounts/${e.ids.homeAccountJuan}`)
        .set(bearer(e.ana))
        .expect(403));

    it('...ni la lista de sus integrantes (nombres, usuarios, correos)', () =>
      api(e.app)
        .get(`/api/accounts/${e.ids.homeAccountJuan}/members`)
        .set(bearer(e.ana))
        .expect(403));
  });

  describe('los códigos RF solo los ve CPS', () => {
    it('el titular ve QUE tiene un código grabado, pero NO cuál es', async () => {
      const res = await api(e.app)
        .get(`/api/remotes/${e.ids.controlJuan}/codes`)
        .set(bearer(e.juan))
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect(JSON.stringify(res.body)).not.toContain('A1B2C3D4');
    });

    it('el titular NO puede revelar el código de su PROPIO control', () =>
      api(e.app)
        .get(`/api/remotes/${e.ids.controlJuan}/codes/1/reveal`)
        .set(bearer(e.juan))
        .expect(403));

    it('el admin del barrio tampoco puede revelarlo', () =>
      api(e.app)
        .get(`/api/remotes/${e.ids.controlJuan}/codes/1/reveal`)
        .set(bearer(e.ana))
        .expect(403));

    it('CPS sí: descifra y devuelve el código original', async () => {
      const res = await api(e.app)
        .get(`/api/remotes/${e.ids.controlJuan}/codes/1/reveal`)
        .set(bearer(e.cps))
        .expect(200);
      expect((res.body as { code: string }).code).toBe('A1B2C3D4');
    });

    it('en la BASE el código está cifrado: el texto plano no aparece', async () => {
      const filas: { existe: boolean }[] = await e.dataSource.query(`
        SELECT EXISTS (
          SELECT 1 FROM remote_code
          WHERE position(convert_to('A1B2C3D4','UTF8') in code_encrypted) > 0
        ) AS existe
      `);
      expect(filas[0].existe).toBe(false);
    });
  });

  describe('solo CPS hace las operaciones de empresa', () => {
    it('un admin de barrio NO puede firmar contratos', () =>
      api(e.app)
        .post('/api/contracts')
        .set(bearer(e.ana))
        .send({
          accountId: e.ids.orgA,
          neighborhoodId: e.ids.barrioA,
          price: 1,
          maxFamilyMembers: 1,
          startDate: '2026-01-01',
        })
        .expect(403));

    it('un admin de barrio NO puede crear cuentas', () =>
      api(e.app)
        .post('/api/accounts')
        .set(bearer(e.ana))
        .send({ name: 'Trucha', type: 'HOME' })
        .expect(403));

    it('un admin de barrio NO puede disparar el sync de georef', () =>
      api(e.app).post('/api/geography/sync').set(bearer(e.ana)).expect(403));

    it('un vecino NO puede listar el padrón de usuarios del sistema', () =>
      api(e.app).get('/api/users').set(bearer(e.juan)).expect(403));

    it('un vecino NO puede dar de alta una alarma', () =>
      api(e.app)
        .post('/api/devices')
        .set(bearer(e.juan))
        .send({ name: 'Mía', serial: 'HACK-001', neighborhoodId: e.ids.barrioA })
        .expect(403));
  });

  describe('lo que SÍ tiene que funcionar (que no rompimos nada al cerrar los agujeros)', () => {
    it('Juan administra a su familia: puede ver a su familiar', () =>
      api(e.app)
        .get(`/api/users/${e.ids.familiar}`)
        .set(bearer(e.juan))
        .expect(200));

    it('Juan ve las alarmas de SU barrio (son infraestructura compartida)', async () => {
      const res = await api(e.app)
        .get('/api/devices')
        .set(bearer(e.juan))
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect((res.body as { id: number }[])[0].id).toBe(e.ids.alarmaA);
    });

    it('Ana ve las DOS viviendas de su barrio', async () => {
      const res = await api(e.app)
        .get('/api/homes')
        .set(bearer(e.ana))
        .expect(200);
      expect(res.body).toHaveLength(2);
    });

    it('CPS ve todo: los dos barrios', async () => {
      const res = await api(e.app)
        .get('/api/neighborhoods')
        .set(bearer(e.cps))
        .expect(200);
      expect(res.body).toHaveLength(2);
    });
  });

  describe('sin token no se entra a ningún lado', () => {
    it.each([
      ['/api/neighborhoods'],
      ['/api/homes'],
      ['/api/devices'],
      ['/api/remotes'],
      ['/api/contracts'],
      ['/api/users'],
      ['/api/auth/me'],
    ])('GET %s sin token -> 401', (url) =>
      api(e.app).get(url).expect(401),
    );
  });
});
