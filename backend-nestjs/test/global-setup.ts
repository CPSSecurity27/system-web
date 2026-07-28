import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/database/typeorm.config';

/**
 * Corre UNA vez antes de toda la suite: crea la base de tests si no existe y le
 * aplica las migraciones. Así los tests corren contra el MISMO esquema real
 * (FKs compuestas, CHECKs, índices parciales incluidos), no contra uno inventado.
 */
export default async function globalSetup(): Promise<void> {
  loadEnv();

  const testDb = 'cps_security_test';
  const admin = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: 'postgres',
  });

  await admin.connect();
  const { rowCount } = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [testDb],
  );
  if (rowCount === 0) {
    await admin.query(`CREATE DATABASE ${testDb}`);
  }
  await admin.end();

  const dataSource = new DataSource(
    buildDataSourceOptions({ ...process.env, DB_NAME: testDb, NODE_ENV: 'test' }),
  );
  await dataSource.initialize();
  await dataSource.runMigrations();
  await dataSource.destroy();
}
