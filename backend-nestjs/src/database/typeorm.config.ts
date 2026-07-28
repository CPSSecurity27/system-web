import { DataSourceOptions } from 'typeorm';

/**
 * Única definición de la conexión. La usan el DatabaseModule (en runtime) y el
 * DataSource del CLI (para migraciones), para que no puedan divergir.
 *
 * `synchronize` nunca se activa: el esquema lo gobiernan las migraciones.
 */
export function buildDataSourceOptions(
  env: NodeJS.ProcessEnv,
): DataSourceOptions {
  return {
    type: 'postgres',
    host: env.DB_HOST,
    port: Number(env.DB_PORT),
    username: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    entities: [__dirname + '/../**/*.entity{.ts,.js}'],
    migrations: [__dirname + '/migrations/*{.ts,.js}'],
    synchronize: false,
    logging: env.NODE_ENV === 'development',
  };
}
