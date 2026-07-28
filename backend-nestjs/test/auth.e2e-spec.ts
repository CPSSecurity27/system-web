import { CLAVE, api, Escenario, sembrar } from './helpers';

describe('Auth — sesiones, rotación y contraseñas', () => {
  let e: Escenario;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    e = await sembrar();
  }, 60_000);

  afterAll(async () => {
    await e.app.close();
  });

  const loginRaw = (username: string, password: string) =>
    api(e.app).post('/api/auth/login').send({ username, password });

  describe('login', () => {
    it('con credenciales correctas devuelve access y refresh', async () => {
      const res = await loginRaw('juanp', CLAVE).expect(200);
      expect(res.body).toHaveProperty('accessToken');
      expect(res.body).toHaveProperty('refreshToken');
    });

    it('con contraseña incorrecta da 401', () =>
      loginRaw('juanp', 'incorrecta').expect(401));

    it('con un usuario inexistente da el MISMO 401 (no se puede enumerar quién existe)', async () => {
      const noExiste = await loginRaw('nadie', 'incorrecta').expect(401);
      const claveMala = await loginRaw('juanp', 'incorrecta').expect(401);
      expect(noExiste.body).toEqual(claveMala.body);
    });

    it('un usuario SUSPENDIDO no entra', async () => {
      await api(e.app)
        .patch(`/api/users/${e.ids.familiar}`)
        .set(bearer(e.cps))
        .send({ status: 'SUSPENDED' })
        .expect(200);

      await loginRaw('fam1', CLAVE).expect(401);

      await api(e.app)
        .patch(`/api/users/${e.ids.familiar}`)
        .set(bearer(e.cps))
        .send({ status: 'ACTIVE' })
        .expect(200);
    });
  });

  describe('refresh con rotación', () => {
    it('el refresh usado QUEDA REVOCADO y devuelve uno nuevo', async () => {
      const { body: sesion } = await loginRaw('gaby', CLAVE).expect(200);
      const viejo = (sesion as { refreshToken: string }).refreshToken;

      const { body: renovada } = await api(e.app)
        .post('/api/auth/refresh')
        .send({ refreshToken: viejo })
        .expect(200);
      const nuevo = (renovada as { refreshToken: string }).refreshToken;

      expect(nuevo).not.toBe(viejo);

      // Un refresh robado deja de servir apenas el legítimo lo usa.
      await api(e.app)
        .post('/api/auth/refresh')
        .send({ refreshToken: viejo })
        .expect(401);
    });

    it('después del logout el refresh ya no sirve', async () => {
      const { body } = await loginRaw('gaby', CLAVE).expect(200);
      const token = (body as { refreshToken: string }).refreshToken;

      await api(e.app)
        .post('/api/auth/logout')
        .send({ refreshToken: token })
        .expect(204);

      await api(e.app)
        .post('/api/auth/refresh')
        .send({ refreshToken: token })
        .expect(401);
    });
  });

  describe('cambio de contraseña', () => {
    it('exige la contraseña ACTUAL (un access token robado no alcanza)', async () => {
      const token = (await loginRaw('beto', CLAVE).expect(200)).body as {
        accessToken: string;
      };
      await api(e.app)
        .post('/api/auth/change-password')
        .set(bearer(token.accessToken))
        .send({ currentPassword: 'noesesta', newPassword: 'OtraClave2026!' })
        .expect(401);
    });

    it('al cambiarla se revocan TODAS las sesiones, en todos los dispositivos', async () => {
      const celular = (await loginRaw('beto', CLAVE).expect(200)).body as {
        accessToken: string;
        refreshToken: string;
      };
      const web = (await loginRaw('beto', CLAVE).expect(200)).body as {
        refreshToken: string;
      };

      await api(e.app)
        .post('/api/auth/change-password')
        .set(bearer(celular.accessToken))
        .send({ currentPassword: CLAVE, newPassword: 'OtraClave2026!' })
        .expect(204);

      // Ni la sesión donde la cambió, ni la del otro dispositivo.
      await api(e.app)
        .post('/api/auth/refresh')
        .send({ refreshToken: celular.refreshToken })
        .expect(401);
      await api(e.app)
        .post('/api/auth/refresh')
        .send({ refreshToken: web.refreshToken })
        .expect(401);

      await loginRaw('beto', CLAVE).expect(401);
      await loginRaw('beto', 'OtraClave2026!').expect(200);
    });
  });

  describe('recuperación de contraseña', () => {
    it('un correo inexistente da 202 igual (no es un buscador de quién tiene cuenta)', () =>
      api(e.app)
        .post('/api/auth/forgot-password')
        .send({ email: 'nadie@ejemplo.com' })
        .expect(202));

    it('un token de reseteo inventado da 400', () =>
      api(e.app)
        .post('/api/auth/reset-password')
        .send({ token: 'inventado', newPassword: 'LoQueSea2026!' })
        .expect(400));
  });

  describe('/auth/me', () => {
    it('devuelve las membresías como el par (tipo de cuenta, rol)', async () => {
      const res = await api(e.app)
        .get('/api/auth/me')
        .set(bearer(e.juan))
        .expect(200);
      expect(res.body).toMatchObject({
        username: 'juanp',
        memberships: [
          {
            accountId: e.ids.homeAccountJuan,
            accountType: 'HOME',
            role: 'ADMIN',
          },
        ],
      });
    });

    it('nunca devuelve el hash de la contraseña', async () => {
      const res = await api(e.app)
        .get('/api/auth/me')
        .set(bearer(e.cps))
        .expect(200);
      expect(JSON.stringify(res.body)).not.toContain('argon2');
    });
  });
});
