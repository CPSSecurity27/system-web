import { CLAVE, api, Escenario, sembrar } from './helpers';

/**
 * Las reglas del dominio. Algunas las impone la BASE (FK compuesta, CHECKs,
 * índices únicos parciales) y otras el código (§5: las que la base no puede).
 * Desde afuera no se nota la diferencia, y por eso se prueban igual: por HTTP.
 */
describe('Negocio — invariantes del modelo', () => {
  let e: Escenario;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    e = await sembrar();
  }, 60_000);

  afterAll(async () => {
    await e.app.close();
  });

  describe('contratos', () => {
    it('una cuenta COMPANY NO puede contratar: CPS presta el servicio, no lo contrata', () =>
      api(e.app)
        .post('/api/contracts')
        .set(bearer(e.cps))
        .send({
          accountId: 1, // la cuenta COMPANY
          neighborhoodId: e.ids.barrioA,
          price: 1,
          maxFamilyMembers: 1,
          startDate: '2026-01-01',
        })
        .expect(400));

    it('una cuenta ORGANIZATION contrata un BARRIO, no una vivienda', () =>
      api(e.app)
        .post('/api/contracts')
        .set(bearer(e.cps))
        .send({
          accountId: e.ids.orgA,
          homeId: e.ids.casaJuan, // destino equivocado para el tipo de cuenta
          price: 1,
          maxFamilyMembers: 1,
          startDate: '2026-01-01',
        })
        .expect(400));

    it('un barrio NO puede tener dos contratos ACTIVE a la vez (409)', () =>
      api(e.app)
        .post('/api/contracts')
        .set(bearer(e.cps))
        .send({
          accountId: e.ids.orgA,
          neighborhoodId: e.ids.barrioA, // ya tiene uno ACTIVE
          price: 999,
          maxFamilyMembers: 3,
          startDate: '2026-06-01',
        })
        .expect(409));

    it('la fecha de fin no puede ser anterior a la de inicio', () =>
      api(e.app)
        .post('/api/contracts')
        .set(bearer(e.cps))
        .send({
          accountId: e.ids.homeAccountGaby,
          homeId: e.ids.casaGaby,
          price: 1,
          maxFamilyMembers: 1,
          startDate: '2026-06-01',
          endDate: '2026-01-01',
        })
        .expect(400));

    it('el precio conserva los decimales (NUMERIC, no punto flotante)', async () => {
      const res = await api(e.app)
        .get(`/api/contracts/${e.ids.contratoBarrioA}`)
        .set(bearer(e.cps))
        .expect(200);
      expect((res.body as { price: number }).price).toBe(150000.5);
    });
  });

  /**
   * El alta de un cliente. Dos caminos, y la diferencia NO es cosmética:
   *
   *  COMMUNITY  nace con su único barrio, así que hay contra qué contratar:
   *             el contrato entra al mismo acto atómico y es obligatorio.
   *  MUNICIPAL  nace SIN barrios (los crea después, contra su cupo), así que
   *             no puede haber contrato todavía. Eso es válido, no un dato
   *             faltante.
   */
  describe('alta de clientes', () => {
    const contrato = {
      price: 12345.67,
      startDate: '2026-08-01',
      description: 'Contrato de prueba',
    };

    const comunidad = (over: Record<string, unknown> = {}) => ({
      name: `Consorcio ${Math.random().toString(36).slice(2, 8)}`,
      managedBy: 'CPS',
      maxAdminUsers: 1,
      maxTechnicianUsers: 0,
      maxMonitorUsers: 1,
      ownerUsername: `owner_${Math.random().toString(36).slice(2, 8)}`,
      neighborhood: { name: 'Barrio del consorcio', localityId: e.ids.localidad },
      contract: contrato,
      ...over,
    });

    it('una comunitaria NO se puede crear sin contrato', () => {
      const { contract: _sinContrato, ...sinContrato } = comunidad();
      return api(e.app)
        .post('/api/accounts/onboard-community')
        .set(bearer(e.cps))
        .send(sinContrato)
        .expect(400);
    });

    it('una comunitaria nace con su barrio Y su contrato, en un solo acto', async () => {
      const res = await api(e.app)
        .post('/api/accounts/onboard-community')
        .set(bearer(e.cps))
        .send(comunidad())
        .expect(201);

      const body = res.body as { neighborhoodId: number; contractId: number };
      expect(typeof body.contractId).toBe('number');

      const contratoCreado = await api(e.app)
        .get(`/api/contracts/${body.contractId}`)
        .set(bearer(e.cps))
        .expect(200);

      const c = contratoCreado.body as { price: number; neighborhoodId: number };
      expect(c.price).toBe(12345.67);
      expect(c.neighborhoodId).toBe(body.neighborhoodId);
    });

    it('una municipalidad nace SIN barrios y SIN contrato, y eso es válido', async () => {
      const name = `Muni ${Math.random().toString(36).slice(2, 8)}`;
      const res = await api(e.app)
        .post('/api/accounts/onboard-municipal')
        .set(bearer(e.cps))
        .send({
          name,
          maxNeighborhoods: 5,
          maxAdminUsers: 2,
          maxTechnicianUsers: 1,
          maxMonitorUsers: 1,
          ownerUsername: `muni_${Math.random().toString(36).slice(2, 8)}`,
        })
        .expect(201);

      const body = res.body as { account: { id: number }; temporaryPassword: string };
      expect(typeof body.temporaryPassword).toBe('string');

      const barrios = await api(e.app)
        .get(`/api/neighborhoods?organizationId=${body.account.id}`)
        .set(bearer(e.cps))
        .expect(200);
      expect(barrios.body).toEqual([]);
    });

    /**
     * EL bug que este alta cierra. Antes eran tres llamadas encadenadas desde
     * el front: si fallaba la del OWNER, quedaba una cuenta que nadie podía
     * administrar. Que el mensaje diga cuál falló no deshace lo ya creado.
     */
    it('el alta municipal es ATÓMICA: si el OWNER falla, NO queda cuenta huérfana', async () => {
      const ownerUsername = `dup_${Math.random().toString(36).slice(2, 8)}`;
      const huerfana = `Huerfana ${Math.random().toString(36).slice(2, 8)}`;

      // Primera: se queda con el username.
      await api(e.app)
        .post('/api/accounts/onboard-municipal')
        .set(bearer(e.cps))
        .send({
          name: `Muni ${Math.random().toString(36).slice(2, 8)}`,
          maxNeighborhoods: 1,
          maxAdminUsers: 1,
          maxTechnicianUsers: 0,
          maxMonitorUsers: 0,
          ownerUsername,
        })
        .expect(201);

      // Segunda: mismo username, otro nombre de cuenta. Debe rebotar...
      await api(e.app)
        .post('/api/accounts/onboard-municipal')
        .set(bearer(e.cps))
        .send({
          name: huerfana,
          maxNeighborhoods: 1,
          maxAdminUsers: 1,
          maxTechnicianUsers: 0,
          maxMonitorUsers: 0,
          ownerUsername,
        })
        .expect(409);

      // ...y NO dejar la cuenta creada.
      const res = await api(e.app)
        .get(`/api/accounts?search=${encodeURIComponent(huerfana)}`)
        .set(bearer(e.cps))
        .expect(200);
      expect((res.body as { items: unknown[] }).items).toEqual([]);
    });
  });

  describe('membresías (los invariantes de §5 que la base no puede)', () => {
    it('un TECHNICIAN NO existe en una cuenta HOME', () =>
      api(e.app)
        .post(`/api/accounts/${e.ids.homeAccountJuan}/members`)
        .set(bearer(e.cps))
        .send({ userId: e.ids.gaby, role: 'TECHNICIAN' })
        .expect(400));

    it('NO se puede degradar al ÚLTIMO ADMIN de una cuenta (quedaría huérfana)', () =>
      api(e.app)
        .patch(`/api/accounts/${e.ids.homeAccountJuan}/members/${e.ids.juan}`)
        .set(bearer(e.cps))
        .send({ role: 'USER' })
        .expect(400));

    it('NO se puede sacar al ÚLTIMO ADMIN de una cuenta', () =>
      api(e.app)
        .delete(`/api/accounts/${e.ids.homeAccountJuan}/members/${e.ids.juan}`)
        .set(bearer(e.cps))
        .expect(400));

    it('no se supera el max_family_members del contrato (el de Juan permite 2)', async () => {
      // Ya hay 1 familiar (fam1). El segundo entra…
      const dos = await api(e.app)
        .post('/api/users')
        .set(bearer(e.cps))
        .send({ name: 'Familiar 2', username: 'fam2', password: CLAVE })
        .expect(201);
      await api(e.app)
        .post(`/api/accounts/${e.ids.homeAccountJuan}/members`)
        .set(bearer(e.cps))
        .send({ userId: (dos.body as { id: number }).id, role: 'USER' })
        .expect(201);

      // …y el TERCERO no.
      const tres = await api(e.app)
        .post('/api/users')
        .set(bearer(e.cps))
        .send({ name: 'Familiar 3', username: 'fam3', password: CLAVE })
        .expect(201);
      await api(e.app)
        .post(`/api/accounts/${e.ids.homeAccountJuan}/members`)
        .set(bearer(e.cps))
        .send({ userId: (tres.body as { id: number }).id, role: 'USER' })
        .expect(400);
    });

    it('no se puede crear una segunda cuenta COMPANY', () =>
      api(e.app)
        .post('/api/accounts')
        .set(bearer(e.cps))
        .send({ name: 'CPS Trucha', type: 'COMPANY' })
        .expect(400));
  });

  describe('alarmas (son del BARRIO)', () => {
    it('el serial es único: no se puede repetir', () =>
      api(e.app)
        .post('/api/devices')
        .set(bearer(e.cps))
        .send({
          name: 'Duplicado',
          serial: 'CPS-A1-0001',
          neighborhoodId: e.ids.barrioA,
        })
        .expect(409));

    it('el serial rechaza formatos raros (de él se deriva la ruta al canal de tiempo real)', () =>
      api(e.app)
        .post('/api/devices')
        .set(bearer(e.cps))
        .send({
          name: 'Malo',
          serial: 'con espacios!',
          neighborhoodId: e.ids.barrioA,
        })
        .expect(400));
  });

  describe('controles remotos (DUEÑO ≠ PORTADOR)', () => {
    it('NO se dan de alta si el contrato de la vivienda no los habilita', () =>
      api(e.app)
        .post('/api/remotes')
        .set(bearer(e.cps))
        .send({ name: 'Llavero', homeId: e.ids.casaGaby }) // su contrato no los incluye
        .expect(400));

    it('INVARIANTE 3: el portador debe pertenecer a la cuenta dueña del hogar', () =>
      api(e.app)
        .patch(`/api/remotes/${e.ids.controlJuan}`)
        .set(bearer(e.cps))
        .send({ assignedToUserId: e.ids.gaby }) // Gaby es de OTRA casa
        .expect(400));

    it('el portador SÍ se puede asignar a alguien de la casa', async () => {
      const res = await api(e.app)
        .patch(`/api/remotes/${e.ids.controlJuan}`)
        .set(bearer(e.cps))
        .send({ assignedToUserId: e.ids.juan })
        .expect(200);
      expect(res.body).toMatchObject({
        assignedToUserId: e.ids.juan,
        homeId: e.ids.casaJuan, // la vivienda sigue siendo la DUEÑA
      });
    });

    it('no se puede grabar el control en la alarma de OTRO barrio', () =>
      api(e.app)
        .patch(`/api/remotes/${e.ids.controlJuan}`)
        .set(bearer(e.cps))
        .send({ deviceId: e.ids.alarmaB })
        .expect(400));

    it('el tope es de 8 códigos: la posición 9 no existe', () =>
      api(e.app)
        .post(`/api/remotes/${e.ids.controlJuan}/codes`)
        .set(bearer(e.cps))
        .send({ code: 'FFFF0000', position: 9 })
        .expect(400));

    it('una posición ya ocupada se rechaza', () =>
      api(e.app)
        .post(`/api/remotes/${e.ids.controlJuan}/codes`)
        .set(bearer(e.cps))
        .send({ code: 'FFFF0000', position: 1 })
        .expect(400));
  });

  describe('geografía', () => {
    it('el buscador ignora acentos: "cordoba" encuentra "Córdoba"', async () => {
      const res = await api(e.app)
        .get('/api/geography/localities/search?search=cordoba')
        .set(bearer(e.cps))
        .expect(200);
      expect((res.body as { name: string }[])[0].name).toBe('Córdoba');
    });

    it('una búsqueda de 1 caracter se rechaza', () =>
      api(e.app)
        .get('/api/geography/localities/search?search=a')
        .set(bearer(e.cps))
        .expect(400));

    it('un id inexistente da 404, no una lista vacía', () =>
      api(e.app)
        .get('/api/geography/provinces/9999/departments')
        .set(bearer(e.cps))
        .expect(404));
  });
});
