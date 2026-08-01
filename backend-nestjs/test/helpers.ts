import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AccountUser } from '../src/accounts/entities/account-user.entity';
import { Account } from '../src/accounts/entities/account.entity';
import { PasswordService } from '../src/auth/password.service';
import { AccountType, EntityStatus, UserRole } from '../src/common/enums';
import { Department } from '../src/geography/entities/department.entity';
import { Locality } from '../src/geography/entities/locality.entity';
import { Province } from '../src/geography/entities/province.entity';
import { User } from '../src/users/entities/user.entity';

export const CLAVE = 'ClaveDePrueba2026!';

/** El escenario de siempre: dos municipios, dos viviendas en el primer barrio. */
export interface Escenario {
  app: INestApplication;
  dataSource: DataSource;
  /** tokens */
  cps: string;
  ana: string; // admin del municipio A
  beto: string; // admin del municipio B
  juan: string; // titular de la Casa 1
  gaby: string; // titular de la Casa 2
  /** ids */
  ids: {
    cpsUser: number;
    ana: number;
    beto: number;
    juan: number;
    gaby: number;
    familiar: number;
    orgA: number;
    orgB: number;
    homeAccountJuan: number;
    homeAccountGaby: number;
    barrioA: number;
    barrioB: number;
    casaJuan: number;
    casaGaby: number;
    contratoBarrioA: number;
    contratoCasaJuan: number;
    localidad: number;
    localidadB: number;
    alarmaA: number;
    alarmaB: number;
    controlJuan: number;
  };
}

export async function crearApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  // Mismo pipeline que main.ts: si no, los tests probarían otra app.
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();
  return app;
}

/** Deja la base vacía. Las tablas de geografía se siembran a mano (sin llamar a georef). */
async function limpiar(dataSource: DataSource): Promise<void> {
  await dataSource.query(`
    TRUNCATE remote_code, remote, device_maintenance, device, service_contract,
             home, neighborhood, account_user, account, user_token, refresh_token,
             app_user, locality, department, province
    RESTART IDENTITY CASCADE
  `);
}

export function api(app: INestApplication) {
  return request(app.getHttpServer() as Parameters<typeof request>[0]);
}

export async function login(
  app: INestApplication,
  username: string,
): Promise<string> {
  // El campo es `identifier` desde el pivot a login por email (2026-07-21):
  // un solo campo para username (panel), email o DNI (vecino). Mandar
  // `username` rebota con 400 por `forbidNonWhitelisted`.
  const res = await api(app)
    .post('/api/auth/login')
    .send({ identifier: username, password: CLAVE })
    .expect(200);
  return (res.body as { accessToken: string }).accessToken;
}

/**
 * Siembra el escenario completo. Todo lo que se puede, por HTTP: así los tests
 * ejercitan los mismos endpoints que usaría el front, no atajos por la base.
 */
export async function sembrar(): Promise<Escenario> {
  const app = await crearApp();
  const dataSource = app.get(DataSource);
  await limpiar(dataSource);

  // --- Geografía mínima (no se llama a georef en los tests) ---
  const provincia = await dataSource
    .getRepository(Province)
    .save({ georefId: '14', name: 'Córdoba', latitude: null, longitude: null });
  const depto = await dataSource.getRepository(Department).save({
    georefId: '14014',
    name: 'Capital',
    provinceId: provincia.id,
    latitude: null,
    longitude: null,
  });
  const localidad = await dataSource.getRepository(Locality).save({
    georefId: '14014010',
    name: 'Córdoba',
    departmentId: depto.id,
    latitude: null,
    longitude: null,
  });
  const localidadB = await dataSource.getRepository(Locality).save({
    georefId: '14091250',
    name: 'Villa Carlos Paz',
    departmentId: depto.id,
    latitude: null,
    longitude: null,
  });

  // --- Bootstrap: cuenta COMPANY + primer admin (lo mismo que hace el CLI) ---
  const passwords = app.get(PasswordService);
  const hash = await passwords.hash(CLAVE);

  const cpsAccount = await dataSource.getRepository(Account).save({
    name: 'CPS Security',
    type: AccountType.COMPANY,
    status: EntityStatus.ACTIVE,
  });
  const cpsUser = await dataSource.getRepository(User).save({
    name: 'Administrador',
    username: 'admin',
    passwordHash: hash,
    status: EntityStatus.ACTIVE,
  });
  await dataSource.getRepository(AccountUser).save({
    accountId: cpsAccount.id,
    userId: cpsUser.id,
    role: UserRole.ADMIN,
    accountType: AccountType.COMPANY,
  });

  const cps = await login(app, 'admin');
  const post = async <T>(url: string, body: object, token = cps): Promise<T> => {
    const res = await api(app)
      .post(url)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
    if (res.status >= 300) {
      throw new Error(`${url} -> ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body as T;
  };

  type ConId = { id: number };

  // --- Cuentas, barrios, contratos ---
  const orgA = await post<ConId>('/api/accounts', {
    name: 'Municipalidad de Córdoba',
    type: 'ORGANIZATION',
  });
  const orgB = await post<ConId>('/api/accounts', {
    name: 'Municipalidad de Carlos Paz',
    type: 'ORGANIZATION',
  });

  const barrioA = await post<ConId>('/api/neighborhoods', {
    name: 'Barrio Jardín',
    localityId: localidad.id,
  });
  const barrioB = await post<ConId>('/api/neighborhoods', {
    name: 'Barrio Sol y Lago',
    localityId: localidadB.id,
  });

  const contratoBarrioA = await post<ConId>('/api/contracts', {
    accountId: orgA.id,
    neighborhoodId: barrioA.id,
    price: 150000.5,
    maxFamilyMembers: 5,
    startDate: '2026-01-01',
  });
  await post<ConId>('/api/contracts', {
    accountId: orgB.id,
    neighborhoodId: barrioB.id,
    price: 98000,
    maxFamilyMembers: 4,
    startDate: '2026-01-01',
  });

  // --- Admins de cada municipio ---
  const ana = await post<ConId>('/api/users', {
    name: 'Ana Admin',
    username: 'ana',
    password: CLAVE,
  });
  await post(`/api/accounts/${orgA.id}/members`, {
    userId: ana.id,
    role: 'ADMIN',
  });
  const beto = await post<ConId>('/api/users', {
    name: 'Beto Admin',
    username: 'beto',
    password: CLAVE,
  });
  await post(`/api/accounts/${orgB.id}/members`, {
    userId: beto.id,
    role: 'ADMIN',
  });

  // --- Dos viviendas en el barrio A, con su cuenta HOME y su titular ---
  const casaJuan = await post<ConId>('/api/homes', {
    name: 'Casa 1',
    neighborhoodId: barrioA.id,
  });
  const casaGaby = await post<ConId>('/api/homes', {
    name: 'Casa 2',
    neighborhoodId: barrioA.id,
  });

  const homeAccountJuan = await post<ConId>('/api/accounts', {
    name: 'Familia Pérez',
    type: 'HOME',
  });
  const homeAccountGaby = await post<ConId>('/api/accounts', {
    name: 'Familia Gómez',
    type: 'HOME',
  });

  // El contrato de Juan SÍ habilita controles remotos; el de Gaby no.
  const contratoCasaJuan = await post<ConId>('/api/contracts', {
    accountId: homeAccountJuan.id,
    homeId: casaJuan.id,
    price: 25000,
    maxFamilyMembers: 2,
    startDate: '2026-01-01',
    remoteControlsEnabled: true,
  });
  await post<ConId>('/api/contracts', {
    accountId: homeAccountGaby.id,
    homeId: casaGaby.id,
    price: 25000,
    maxFamilyMembers: 3,
    startDate: '2026-01-01',
  });

  const juan = await post<ConId>('/api/users', {
    name: 'Juan Titular',
    username: 'juanp',
    password: CLAVE,
  });
  await post(`/api/accounts/${homeAccountJuan.id}/members`, {
    userId: juan.id,
    role: 'ADMIN',
  });
  const familiar = await post<ConId>('/api/users', {
    name: 'Familiar 1',
    username: 'fam1',
    password: CLAVE,
  });
  await post(`/api/accounts/${homeAccountJuan.id}/members`, {
    userId: familiar.id,
    role: 'USER',
  });

  const gaby = await post<ConId>('/api/users', {
    name: 'Gaby Gómez',
    username: 'gaby',
    password: CLAVE,
  });
  await post(`/api/accounts/${homeAccountGaby.id}/members`, {
    userId: gaby.id,
    role: 'ADMIN',
  });

  // --- Alarmas y un control con su código RF ---
  const alarmaA = await post<ConId>('/api/devices', {
    name: 'Poste esquina Norte',
    serial: 'CPS-A1-0001',
    neighborhoodId: barrioA.id,
  });
  const alarmaB = await post<ConId>('/api/devices', {
    name: 'Poste Carlos Paz',
    serial: 'CPS-B1-0001',
    neighborhoodId: barrioB.id,
  });

  const controlJuan = await post<ConId>('/api/remotes', {
    name: 'Llavero cocina',
    homeId: casaJuan.id,
    deviceId: alarmaA.id,
  });
  await post(`/api/remotes/${controlJuan.id}/codes`, {
    code: 'A1B2C3D4',
    position: 1,
  });

  return {
    app,
    dataSource,
    cps,
    ana: await login(app, 'ana'),
    beto: await login(app, 'beto'),
    juan: await login(app, 'juanp'),
    gaby: await login(app, 'gaby'),
    ids: {
      cpsUser: cpsUser.id,
      ana: ana.id,
      beto: beto.id,
      juan: juan.id,
      gaby: gaby.id,
      familiar: familiar.id,
      orgA: orgA.id,
      orgB: orgB.id,
      homeAccountJuan: homeAccountJuan.id,
      homeAccountGaby: homeAccountGaby.id,
      barrioA: barrioA.id,
      barrioB: barrioB.id,
      casaJuan: casaJuan.id,
      casaGaby: casaGaby.id,
      contratoBarrioA: contratoBarrioA.id,
      contratoCasaJuan: contratoCasaJuan.id,
      localidad: localidad.id,
      localidadB: localidadB.id,
      alarmaA: alarmaA.id,
      alarmaB: alarmaB.id,
      controlJuan: controlJuan.id,
    },
  };
}
