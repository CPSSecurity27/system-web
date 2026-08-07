import { plainToInstance, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvironmentVariables {
  @IsEnum(Environment)
  NODE_ENV: Environment = Environment.Development;

  // process.env siempre entrega strings: @Type fuerza la conversión antes de validar.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3000;

  @IsString()
  @IsNotEmpty()
  DB_HOST!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  DB_PORT!: number;

  @IsString()
  @IsNotEmpty()
  DB_USER!: string;

  @IsString()
  @IsNotEmpty()
  DB_PASSWORD!: string;

  @IsString()
  @IsNotEmpty()
  DB_NAME!: string;

  /**
   * Credenciales admin SOLO para el CLI de migraciones (DDL). La app corre como
   * cps_web (roles de §13) y no puede crear tablas; Nest nunca usa estas dos.
   */
  @IsOptional()
  @IsString()
  DB_MIGRATIONS_USER?: string;

  @IsOptional()
  @IsString()
  DB_MIGRATIONS_PASSWORD?: string;

  /**
   * Firma los access tokens. Si se filtra, cualquiera emite tokens válidos:
   * va en .env (no versionado) y en producción debe ser un valor largo y random.
   */
  @IsString()
  @MinLength(32, {
    message: 'JWT_SECRET debe tener al menos 32 caracteres',
  })
  JWT_SECRET!: string;

  /** Access token corto: es stateless y NO se puede revocar. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  JWT_ACCESS_TTL_MINUTES = 15;

  /** Refresh token largo: sí es revocable (vive hasheado en la base). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  JWT_REFRESH_TTL_DAYS = 30;

  /** Base de la API. Se usa para el link de verificación de correo. */
  @IsString()
  @IsNotEmpty()
  APP_URL = 'http://localhost:3000';

  /**
   * Base del FRONT. El link de reseteo apunta acá, no a la API: el usuario tiene
   * que ver un formulario para tipear la clave nueva. Si falta, cae a APP_URL.
   */
  @IsOptional()
  @IsString()
  FRONTEND_URL?: string;

  /**
   * SMTP. Todo opcional: sin SMTP_HOST el sistema arranca igual y los mails se
   * loguean en vez de enviarse (útil en local). Si SMTP_HOST está, MailerService
   * exige user y password y valida la conexión al arrancar.
   */
  @IsOptional()
  @IsString()
  SMTP_HOST?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  SMTP_PORT = 587;

  @IsOptional()
  @IsString()
  SMTP_USER?: string;

  @IsOptional()
  @IsString()
  SMTP_PASSWORD?: string;

  /** Remitente. Si falta, se usa SMTP_USER. */
  @IsOptional()
  @IsString()
  SMTP_FROM?: string;

  /**
   * Clave AES-256 (32 bytes en base64) con la que se cifran los códigos RF de los
   * controles remotos — los que ABREN LA ALARMA.
   *
   * No vive en la base: si te roban un dump de Postgres, los códigos no sirven.
   * Si SE PIERDE, los códigos guardados son irrecuperables (hay que reprogramar
   * los controles). Guardala como el secreto crítico que es.
   *
   *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   */
  @IsString()
  @IsNotEmpty({ message: 'REMOTE_CODES_KEY es obligatoria' })
  REMOTE_CODES_KEY!: string;

  /**
   * Clave AES-256 (32 bytes en base64) con la que el PROVISIONER cifra las
   * credenciales del portal local de los equipos. Acá solo se DESCIFRA: la web
   * no las genera nunca.
   *
   * Tiene que ser idéntica a `GTD_CRED_KEY` del provisioner. Si no coinciden, la
   * ficha del equipo muestra las credenciales vacías y no se puede imprimir la
   * etiqueta — pero el equipo funciona igual, así que el síntoma es sutil.
   *
   * Los SALTS de derivación NO van acá. Con un salt se calculan las credenciales
   * de toda la flota, incluidos equipos que todavía no existen; con esta clave
   * solo se leen las de los que ya están en esta base.
   *
   *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   */
  @IsString()
  @IsNotEmpty({ message: 'CPS_CRED_KEY es obligatoria' })
  CPS_CRED_KEY!: string;

  /**
   * Cuánto espera el alta de fábrica a que el provisioner confirme, en ms.
   *
   * El alta es ATÓMICA: si vence sin confirmación, el equipo recién creado se
   * BORRA. Generoso a propósito — el camino incluye un `systemctl reload
   * mosquitto` sobre una Raspberry.
   */
  @IsOptional()
  @IsInt()
  @Min(5000)
  @Type(() => Number)
  PROVISIONING_TIMEOUT_MS?: number;

  /**
   * Dónde se guardan los `.bin` del catálogo de firmwares.
   *
   * Tiene que ser una carpeta que **nginx sirva bajo `/firmware/` en el APEX
   * `cpssecurity.com.ar`**, y el host es exacto: el firmware compara contra
   * `OTA_ALLOWED_HOST` y rechaza cualquier otro antes de bajar un byte, así que
   * servirlos desde `system.cpssecurity.com.ar` no funciona.
   *
   * En el servidor: `/home/servidorcps/SistemaCPS/web/firmware`.
   *
   * Es opcional para que un entorno de desarrollo sin OTA arranque igual; el
   * módulo tira un error claro cuando falta y alguien intenta subir algo.
   */
  @IsOptional()
  @IsString()
  FIRMWARE_ROOT?: string;
}

export function validateEnv(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    exposeDefaultValues: true,
  });

  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    const detalle = errors
      .map(
        (e) =>
          `  - ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
      )
      .join('\n');
    throw new Error(`Configuración de entorno inválida:\n${detalle}`);
  }

  return validated;
}
