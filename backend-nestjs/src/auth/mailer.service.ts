import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transporter, createTransport } from 'nodemailer';

/**
 * Envío de mails por SMTP.
 *
 * Si SMTP_HOST no está configurado, NO manda: loguea el link por consola. Eso
 * permite trabajar en local sin credenciales, y sobre todo evita el peor
 * escenario —que el sistema crea que mandó un mail que nunca salió—: cuando está
 * en modo log lo dice en cada envío, bien fuerte.
 */
@Injectable()
export class MailerService implements OnModuleInit {
  private readonly logger = new Logger(MailerService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const host = this.config.get<string>('SMTP_HOST');
    if (!host) {
      this.logger.warn(
        'SMTP_HOST no configurado: los mails NO se envían, se loguean por consola.',
      );
      return;
    }

    const port = Number(this.config.get('SMTP_PORT') ?? 587);

    this.transporter = createTransport({
      host,
      port,
      // 465 es SMTPS (TLS desde el saludo). 587 arranca en claro y sube a TLS
      // con STARTTLS; nodemailer lo hace solo con secure:false.
      secure: port === 465,
      auth: {
        user: this.config.getOrThrow<string>('SMTP_USER'),
        pass: this.config.getOrThrow<string>('SMTP_PASSWORD'),
      },
    });

    // Se valida la conexión AL ARRANCAR y no en el primer mail: si las
    // credenciales están mal, quiero enterarme ahora y no cuando un vecino
    // no reciba su link.
    try {
      await this.transporter.verify();
      this.logger.log(`SMTP conectado (${host}:${port})`);
    } catch (error) {
      this.transporter = null;
      this.logger.error(
        `SMTP NO conecta (${host}:${port}): ${
          error instanceof Error ? error.message : String(error)
        }. Se cae a modo log: los mails no van a salir.`,
      );
    }
  }

  /**
   * El link apunta al FRONT (misma lógica que el reseteo): esa pantalla hace
   * POST /api/auth/verify-email y muestra el resultado con sus botones. Si no
   * hay FRONTEND_URL, cae al GET público de la API, que también verifica.
   */
  async sendEmailVerification(
    to: string,
    name: string,
    token: string,
  ): Promise<void> {
    const frontendUrl = this.config.get<string>('FRONTEND_URL');
    const link = frontendUrl
      ? `${frontendUrl}/verify-email?token=${token}`
      : `${this.config.get<string>('APP_URL') ?? 'http://localhost:3000'}/api/auth/verify-email?token=${token}`;

    await this.send(
      to,
      'Verificá tu correo — CPS Security',
      `Hola ${name},

Para verificar tu correo en CPS Security, entrá a este link:

${link}

El link vence en 24 horas y se puede usar una sola vez.
Si no pediste esto, ignorá el mensaje.`,
    );
  }

  /**
   * El link apunta al FRONT (no a la API): el usuario tiene que ver un
   * formulario donde tipear la contraseña nueva. Esa pantalla es la que después
   * hace POST /api/auth/reset-password con el token y la clave.
   */
  async sendPasswordReset(
    to: string,
    name: string,
    token: string,
  ): Promise<void> {
    const baseUrl =
      this.config.get<string>('FRONTEND_URL') ??
      this.config.get<string>('APP_URL') ??
      'http://localhost:3000';
    const link = `${baseUrl}/reset-password?token=${token}`;

    await this.send(
      to,
      'Recuperá tu contraseña — CPS Security',
      `Hola ${name},

Pediste recuperar tu contraseña de CPS Security. Entrá acá para elegir una nueva:

${link}

El link vence en 1 hora y se puede usar una sola vez.
Al cambiarla se van a cerrar todas tus sesiones abiertas.

Si NO pediste esto, ignorá el mensaje: tu contraseña sigue intacta.`,
    );
  }

  /**
   * Alta de un vecino (v2.1: registra con email, ya no hay DNI+OTP). La
   * cuenta nace SIN contraseña; este mail es la única forma de fijarla. El
   * link reutiliza /reset-password del front: activar y resetear son, para
   * el backend, la misma operación (fija clave + verifica el correo).
   */
  async sendAccountActivation(
    to: string,
    name: string,
    token: string,
  ): Promise<void> {
    const baseUrl =
      this.config.get<string>('FRONTEND_URL') ??
      this.config.get<string>('APP_URL') ??
      'http://localhost:3000';
    const link = `${baseUrl}/activar-cuenta?token=${token}`;

    await this.send(
      to,
      'Activá tu cuenta — CPS Security',
      `Hola ${name},

Te dieron de alta como vecino en CPS Security. Para activar tu cuenta y elegir
tu contraseña, entrá a este link:

${link}

El link vence en 48 horas y se puede usar una sola vez. Una vez que actives tu
cuenta vas a poder entrar con tu email o tu DNI, y la contraseña que elijas.

Si no te esperabas este correo, contactá a quien administra tu barrio.`,
    );
  }

  private async send(to: string, subject: string, text: string): Promise<void> {
    if (!this.transporter) {
      this.logger.warn(
        `[MAILER SIN SMTP — no se envió nada] para=${to} asunto="${subject}"\n${text}`,
      );
      return;
    }

    const from =
      this.config.get<string>('SMTP_FROM') ??
      this.config.getOrThrow<string>('SMTP_USER');

    await this.transporter.sendMail({ from, to, subject, text });
    this.logger.log(`Mail enviado a ${to}: "${subject}"`);
  }
}
