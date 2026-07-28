import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from './typeorm.config';

// Punto de entrada del CLI de TypeORM (migraciones). Nest no pasa por acá.
loadEnv();

// Las migraciones son DDL y la app corre como cps_web, que no puede crear
// tablas (roles de §13). Si hay credenciales admin aparte, el CLI usa esas.
const env: NodeJS.ProcessEnv = { ...process.env };
if (env.DB_MIGRATIONS_USER) {
  env.DB_USER = env.DB_MIGRATIONS_USER;
  env.DB_PASSWORD = env.DB_MIGRATIONS_PASSWORD ?? env.DB_PASSWORD;
}

export default new DataSource(buildDataSourceOptions(env));
