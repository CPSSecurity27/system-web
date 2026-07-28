import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  /**
   * CORS. Sin esto el navegador bloquea CADA request del front.
   *
   * Lista blanca explícita, nunca `origin: true` (que refleja cualquier origen):
   * este backend maneja alarmas y códigos que abren puertas. En desarrollo se
   * permiten los puertos típicos de Vite/CRA.
   *
   * No hace falta `credentials` porque la sesión viaja en el header
   * Authorization, no en una cookie — y eso además nos deja fuera de todo el
   * problema de CSRF.
   */
  const origins = (
    config.get<string>('CORS_ORIGINS') ??
    'http://localhost:5173,http://localhost:3001'
  )
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: origins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  /**
   * Swagger en /api/docs. El plugin de @nestjs/swagger (ver nest-cli.json) lee
   * los DTOs y sus comentarios: la doc sale del código y no se desactualiza.
   *
   * Fuera de desarrollo NO se publica: es un mapa completo de la API, y no hay
   * razón para regalárselo a cualquiera en producción.
   */
  if (config.get('NODE_ENV') !== 'production') {
    const doc = new DocumentBuilder()
      .setTitle('CPS Security — API')
      .setDescription(
        'Backend de monitoreo de alarmas comunitarias.\n\n' +
          '**Autenticación:** `POST /api/auth/login` devuelve un access token (15 min) ' +
          'y un refresh token (30 días). Pegá el access en "Authorize" (arriba a la derecha).\n\n' +
          '**Permisos:** se piden como el par (tipo de cuenta, rol), nunca como un rol suelto. ' +
          'ADMIN en COMPANY es el admin del sistema; ADMIN en HOME es el titular de una vivienda. ' +
          'Además, casi todo endpoint con `:id` verifica ALCANCE: un admin de barrio solo ve el suyo.',
      )
      .setVersion('1.0')
      .addBearerAuth({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Pegá acá el accessToken que devuelve /api/auth/login',
      })
      .addTag('auth', 'Sesiones, contraseñas y verificación de correo')
      .addTag(
        'geography',
        'Provincias, departamentos y localidades (read-only)',
      )
      .addTag('users', 'Alta y ABM de usuarios (no hay registro público)')
      .addTag('accounts', 'Quién contrata, y quién tiene acceso a qué')
      .addTag('neighborhoods', 'Barrios')
      .addTag('homes', 'Viviendas')
      .addTag(
        'contracts',
        'Contratos de servicio (los valores se congelan al firmar)',
      )
      .addTag(
        'devices',
        'Alarmas comunitarias (son del BARRIO, no de la vivienda)',
      )
      .addTag('remotes', 'Controles remotos y códigos RF (SENSIBLE)')
      .build();

    SwaggerModule.setup(
      'api/docs',
      app,
      SwaggerModule.createDocument(app, doc),
      {
        // Deja el token puesto entre recargas: si no, hay que pegarlo cada vez.
        swaggerOptions: { persistAuthorization: true },
      },
    );
  }

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  logger.log(`API      -> http://localhost:${port}/api`);
  if (config.get('NODE_ENV') !== 'production') {
    logger.log(`Swagger  -> http://localhost:${port}/api/docs`);
  }
  logger.log(`CORS     -> ${origins.join(', ')}`);
}
void bootstrap();
