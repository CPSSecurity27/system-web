import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
// `import type` obligatorio: con isolatedModules + emitDecoratorMetadata, un
// tipo usado en una firma decorada no puede importarse como valor.
import type { Request } from 'express';
import type { AuthenticatedUser, AuthTokens } from './auth.service';
import { AuthService } from './auth.service';
import { AllowPasswordPending } from './decorators/allow-password-pending.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  RefreshDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from './dto/auth.dto';
import type { SessionContext } from './token.service';

/**
 * Endpoints de autenticaciÃ³n.
 *
 * El JwtAuthGuard es GLOBAL: todo lo de acÃ¡ exige `Authorization: Bearer <access>`
 * salvo lo marcado con @Public(). Lo pÃºblico NO es "sin autenticar": en cada caso
 * hay algo que prueba la identidad (la contraseÃ±a, el refresh token, o el token
 * del mail). Simplemente no es un access token.
 */
@ApiTags('auth')
@ApiBearerAuth()
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // ---------------------------------------------------------------------------
  // SesiÃ³n
  // ---------------------------------------------------------------------------

  /**
   * POST /api/auth/login          { identifier, password }
   * -> 200 { accessToken, refreshToken }
   *
   * `identifier` es username (panel) o email/DNI (vecino): se busca por los
   * tres. Devuelve el mismo 401 si no existe, si la clave está mal, si está
   * suspendido o si el vecino todavía no activó su cuenta: un atacante no
   * debe poder distinguir esos casos.
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto, @Req() req: Request): Promise<AuthTokens> {
    return this.auth.login(dto.identifier, dto.password, sessionContext(req));
  }

  /**
   * POST /api/auth/refresh        { refreshToken }
   * -> 200 { accessToken, refreshToken }   <- ambos NUEVOS
   *
   * PÃºblico porque el que autentica es el refresh token, no una sesiÃ³n: se llama
   * justamente cuando el access token venciÃ³.
   *
   * ROTA: el refresh usado queda revocado y se devuelve uno nuevo. El cliente
   * DEBE guardar el nuevo â€” el viejo ya no sirve. Y ojo en el front: si varios
   * requests reciben 401 a la vez, tiene que haber UN solo refresh en vuelo, o
   * el primero quema el token y los demÃ¡s fallan.
   */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto, @Req() req: Request): Promise<AuthTokens> {
    return this.auth.refresh(dto.refreshToken, sessionContext(req));
  }

  /**
   * POST /api/auth/logout         { refreshToken }
   * -> 204
   *
   * Cierra ESA sesiÃ³n (revoca ese refresh token). Idempotente: desloguearse dos
   * veces no es un error.
   *
   * OJO: el access token de esa sesiÃ³n sigue siendo vÃ¡lido hasta que venza
   * (15 min). Es el precio de que sea stateless. Para cortar de inmediato hay
   * que suspender al usuario: el guard relee la base en cada request.
   */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Body() dto: RefreshDto): Promise<void> {
    return this.auth.logout(dto.refreshToken);
  }

  /**
   * POST /api/auth/logout-all
   * -> 204
   *
   * Cierra TODAS las sesiones del usuario, en todos sus dispositivos.
   */
  @AllowPasswordPending()
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.auth.logoutAll(user.id);
  }

  /**
   * GET /api/auth/me
   * -> 200 { id, username, name, email, emailVerified, mustChangePassword, memberships[] }
   *
   * `memberships` es lo que el front necesita para saber quÃ© mostrar: trae el
   * par (accountType, role) de cada cuenta. Un rol suelto no alcanza â€” ADMIN en
   * COMPANY es el admin del sistema; ADMIN en HOME es el titular de una casa.
   *
   * @AllowPasswordPending: con clave temporal sin cambiar, el front igual
   * necesita este endpoint para ENTERARSE de que tiene que cambiarla.
   */
  @AllowPasswordPending()
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  // ---------------------------------------------------------------------------
  // ContraseÃ±a
  // ---------------------------------------------------------------------------

  /**
   * POST /api/auth/change-password    { currentPassword, newPassword }
   * -> 204
   *
   * Para el usuario que SE ACUERDA de su clave y estÃ¡ logueado. AcÃ¡ no hace
   * falta ningÃºn token por mail: la contraseÃ±a actual YA es la prueba de
   * identidad. Se la pedimos para que un access token robado no alcance para
   * secuestrar la cuenta.
   *
   * Revoca TODAS las sesiones, incluida esta: hay que volver a loguearse en
   * todos lados. Si no lo hiciera, cambiar la clave no echarÃ­a al que te la robÃ³
   * â€” su refresh token seguirÃ­a vivo 30 dÃ­as.
   *
   * @AllowPasswordPending: es JUSTAMENTE la salida del bloqueo por clave
   * temporal â€” tiene que quedar accesible mientras `mustChangePassword` es true.
   */
  @AllowPasswordPending()
  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    return this.auth.changePassword(
      user.id,
      dto.currentPassword,
      dto.newPassword,
      dto.email,
    );
  }

  /**
   * POST /api/auth/forgot-password    { email }
   * -> 202  SIEMPRE, exista o no ese correo
   *
   * Para el usuario que NO puede entrar. Como no sabe la clave, no tiene con quÃ©
   * probar quiÃ©n esâ€¦ salvo demostrando que controla su casilla. AhÃ­ el token del
   * mail ES la prueba de identidad: no reemplaza a la contraseÃ±a actual,
   * reemplaza su ausencia.
   *
   * Responde 202 aunque el correo no exista, a propÃ³sito. Si devolviera 404
   * serÃ­a un buscador gratuito de quiÃ©n tiene cuenta en el sistema.
   */
  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  forgotPassword(@Body() dto: ForgotPasswordDto): Promise<void> {
    return this.auth.forgotPassword(dto.email);
  }

  /**
   * POST /api/auth/reset-password     { token, newPassword }
   * -> 200 { ok: true }
   *
   * Consume el token del mail (un solo uso, vence en 1 HORA â€” no 24 como el de
   * verificaciÃ³n: este abre la cuenta entera) y pone la clave nueva.
   *
   * Revoca todas las sesiones y ademÃ¡s marca el correo como verificado: el
   * usuario acaba de probar que tiene acceso a esa casilla.
   *
   * El link del mail apunta al FRONT (una pantalla con el formulario), y esa
   * pantalla es la que llama a este endpoint.
   */
  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<{ ok: true }> {
    await this.auth.resetPassword(dto.token, dto.newPassword);
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // VerificaciÃ³n de correo
  // ---------------------------------------------------------------------------

  /**
   * POST /api/auth/request-email-verification
   * -> 202
   *
   * Dispara (o re-dispara) el mail de verificaciÃ³n al usuario logueado. Falla si
   * no tiene correo cargado o si ya estÃ¡ verificado. Pedir uno nuevo invalida el
   * link anterior.
   */
  @Post('request-email-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  requestEmailVerification(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    return this.auth.requestEmailVerification(user.id);
  }

  /**
   * GET /api/auth/verify-email?token=...
   * -> 200 { ok: true }
   *
   * Es la URL que va en el mail, por eso es GET y es pÃºblica: el usuario le hace
   * click, y puede abrirla en un dispositivo donde no estÃ¡ logueado. Lo que
   * autentica la operaciÃ³n es el token del link, no una sesiÃ³n.
   *
   * Verificar el correo no es un endpoint aparte para el vecino: su cuenta ya
   * queda verificada al activarla (ver auth.service#resetPassword). Esto
   * sigue existiendo para el panel, donde el correo es opcional y no bloquea
   * el login: habilita cosas puntuales (recuperar la clave, recibir avisos).
   */
  @Public()
  @Get('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmailFromLink(
    @Query() dto: VerifyEmailDto,
  ): Promise<{ ok: true }> {
    await this.auth.verifyEmail(dto.token);
    return { ok: true };
  }

  /**
   * POST /api/auth/verify-email       { token }
   * -> 200 { ok: true }
   *
   * Misma operaciÃ³n que el GET, para cuando el front prefiere interceptar el
   * link, mostrar su propia pantalla y mandar el token por acÃ¡.
   */
  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<{ ok: true }> {
    await this.auth.verifyEmail(dto.token);
    return { ok: true };
  }
}

/** user-agent + IP: quedan guardados en refresh_token para poder auditar sesiones. */
function sessionContext(req: Request): SessionContext {
  return {
    userAgent: req.headers['user-agent'] ?? null,
    ipAddress: req.ip ?? null,
  };
}
