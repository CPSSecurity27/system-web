# Auth — JWT, RBAC y verificación de email (v2)

## Arranque (huevo y gallina)

No hay registro público: **a los usuarios los crea un admin**. El arranque es por CLI:

```bash
npm run auth:bootstrap -- <owner_username> <owner_password> [admin_username] [admin_password] [admin_email]
```

Crea la cuenta COMPANY (CPS Security), su **OWNER institucional** (patrón "cuenta
root": `kind = INSTITUTIONAL`, solo soberanía, poco uso) y, opcionalmente, el
primer ADMIN humano para la operación diaria. El OWNER queda con
`created_by = NULL` — el primer usuario del sistema no tiene creador. Idempotente.

## Tokens

- **Access token**: JWT stateless, corto (15 min). NO se puede revocar; por eso es corto.
- **Refresh token**: largo (30 días), aleatorio de 256 bits, guardado **hasheado** (SHA-256)
  en `refresh_token`. Sí es revocable — sin esto, echar a un técnico no cerraría su sesión.
- **Rotación**: cada `/auth/refresh` revoca el token usado y emite uno nuevo. Un refresh
  robado deja de servir apenas el legítimo lo use.
- Contraseñas con **argon2id**. La base nunca ve el valor en claro.

El login tarda lo mismo exista o no el usuario (se verifica contra un hash señuelo),
para que no se puedan enumerar identificadores midiendo el tiempo de respuesta.

## Login: `identifier` + password

`POST /auth/login { identifier, password }` — `identifier` se busca contra
`username`, `email` y `dni` a la vez (`where: [{username}, {email}, {dni}]`, un
OR entre tres columnas únicas, sin ambigüedad posible). El panel loguea con su
`username`; el vecino, con su email o su DNI (v2.1 — ver "Alta del vecino" más
abajo). Mismo 401 para "no existe", "clave mala", "suspendido" y "vecino que
todavía no activó la cuenta": un atacante no debe poder distinguirlos.

## Endpoints (`/api/auth`)

| método | ruta | auth |
|---|---|---|
| POST | `/login` | pública |
| POST | `/refresh` | pública (el refresh token autentica) |
| POST | `/logout` | pública (idem) |
| POST | `/logout-all` | token — cierra todas las sesiones |
| POST | `/change-password` | token — **revoca todas las sesiones** |
| POST | `/forgot-password` | pública — siempre 202 |
| POST | `/reset-password` | pública (el token del mail autentica) |
| GET | `/me` | token |
| POST | `/request-email-verification` | token |
| GET\|POST | `/verify-email?token=` | pública (el link del mail autentica) |

## RBAC (v2)

**El guard es global**: todo endpoint exige token salvo que se marque `@Public()`.
El default es cerrado; abrir es lo explícito.

Los permisos del panel se piden como el **par (tipo de cuenta, rol)** — roles v2:
`OWNER | ADMIN | TECHNICIAN | MONITOR`, válidos en COMPANY y ORGANIZATION:

```ts
@RequireMembership({ accountType: AccountType.COMPANY, roles: [UserRole.OWNER, UserRole.ADMIN] })
```

**Los vecinos NO tienen cuenta** (no existe el tipo HOME): su acceso es la
membresía de hogar (`home_member`, cargada en `AuthenticatedUser.homeMemberships`).
Por eso los endpoints donde participa el titular (editar SU vivienda, sus
familiares, el portador de sus controles) no llevan `@RequireMembership`: el
permiso se valida en el servicio contra la membresía de hogar + el alcance.

Alcanza con que **una** membresía cumpla: un técnico de CPS que además es vecino
tiene una membresía de cuenta y una de hogar, y cada una lo habilita para cosas
distintas.

El `JwtAuthGuard` relee el usuario de la base en cada request: un usuario suspendido deja
de entrar **ya**, sin esperar a que venza su access token.

## Cambio de contraseña

`POST /auth/change-password` exige la **contraseña actual** (un access token robado no
alcanza para secuestrar la cuenta) y **revoca TODAS las sesiones**, incluida la del
dispositivo donde se cambió.

Eso es lo que hace que cambiar la clave sirva de algo: si alguien te robó la cuenta,
cambiarla sin cerrar sus sesiones **no lo echa** — su refresh token seguiría vivo 30 días.
Al revocar todo, en 15 min (lo que dura el access token) queda afuera sí o sí.

Efecto asumido: hay que volver a loguearse en todos los dispositivos. Es el
comportamiento correcto y el que espera cualquiera que cambia su clave por sospecha.

## Recuperación ("me la olvidé") — es OTRO flujo

No confundir con el anterior. Son problemas opuestos:

| | quién | qué prueba la identidad |
|---|---|---|
| `change-password` | el que **está adentro** y se acuerda | **la contraseña actual** |
| `forgot` + `reset` | el que **no puede entrar** | **el token del mail** |

En el primero un token por mail sería redundante (ya probó saber la clave). En el segundo
el token es lo único que hay: **no reemplaza a la contraseña actual, reemplaza su ausencia**.

```
POST /auth/forgot-password  { email }              -> 202 SIEMPRE
POST /auth/reset-password   { token, newPassword } -> 200
```

- `forgot-password` responde **202 aunque el correo no exista**. Si devolviera 404 sería un
  buscador gratuito de quién tiene cuenta en el sistema.
- El token de reseteo vence en **1 hora**, no 24 como el de verificación: este **abre la
  cuenta entera**.
- `reset-password` revoca **todas** las sesiones y además **marca el correo como
  verificado** — el usuario acaba de probar que tiene acceso a esa casilla.
- El link del mail apunta a `FRONTEND_URL/reset-password?token=...`: el front muestra el
  formulario y desde ahí llama al endpoint.

## Alta del vecino y activación de cuenta (v2.1)

SMS y WhatsApp salían caros y no había proveedor contratado, así que el vecino
**dejó el DNI + OTP** (quedó pospuesto, ver `docs/estado-proyecto.md`) y pasó a
registrarse con **email**, entrando después con email o DNI + contraseña —
el mismo mecanismo que el panel.

`UsersService.create` (`POST /api/users`, sin `username`): exige `email`,
rechaza que le manden `password` (el gestor no debe conocer la clave del
vecino) y crea la fila con `password_hash = NULL`. Sin contraseña no hay forma
de loguear, así que el mismo alta dispara el mail de activación.

La activación **reutiliza `reset-password` sin cambios**: fijar la contraseña
por primera vez y resetearla son, para ese método, la misma operación (pone
`password_hash`, marca `email_verified_at`, revoca sesiones — de las que un
vecino nuevo no tiene ninguna, así que no hay efecto). Solo cambia el texto del
mail (`sendAccountActivation`) y el link, que apunta a
`FRONTEND_URL/activar-cuenta` en vez de `/reset-password` (misma pantalla del
front, con copy distinto según la ruta). El token es el mismo `PASSWORD_RESET`
de siempre, con más margen (**48 horas**, no 1): nadie quedó afuera de una
cuenta que ya usaba, así que no hay la misma urgencia que en un reseteo.

`user_device` y `UserTokenType.PHONE_OTP` quedan sin uso: no hace falta
borrarlos, simplemente el flujo que los iba a necesitar no se construyó.

## Verificación de email

`app_user.email_verified_at` (TIMESTAMPTZ nullable), **no un booleano**: dice "sí" y
también "desde cuándo".

**No bloquea el login del panel** (`username`, con `email` nullable y opcional).
Para el vecino la verificación queda resuelta de otra forma: activar la cuenta
YA verifica el correo en el mismo paso (ver arriba), así que nunca hay un
vecino con contraseña y el correo sin verificar.

No se toca `status`: son **ejes ortogonales**. `status` es el estado administrativo
(un admin te suspendió); la verificación es si probaste que el correo es tuyo. Se puede
estar verificado y suspendido a la vez.

Los tokens viven en `user_token` (genérica: verificación hoy, reseteo de contraseña
mañana). Se guarda solo el hash, son de **un solo uso** (`used_at`) y vencen a las 24h.
Pedir uno nuevo invalida el anterior.

## Mailer (SMTP)

`MailerService` manda por SMTP con nodemailer. La conexión se **valida al arrancar**
(`transporter.verify()`), no en el primer mail: si las credenciales están mal querés
enterarte ahí y no cuando un vecino no reciba su link.

**Sin `SMTP_HOST` no envía: loguea el mail por consola** y lo avisa por WARN en cada
envío. Sirve para trabajar en local sin credenciales, y evita el peor escenario — que el
sistema crea que mandó un mail que nunca salió.

Con **Gmail**, `SMTP_PASSWORD` es una *contraseña de aplicación* de 16 caracteres
(https://myaccount.google.com/apppasswords), **no** la clave de la cuenta, y requiere 2FA
activo. Puerto 587 (STARTTLS) o 465 (TLS directo); el código elige `secure` según el puerto.

## Env

```
JWT_SECRET=<48 bytes random, mín. 32 chars>   # si se filtra, cualquiera emite tokens
JWT_ACCESS_TTL_MINUTES=15
JWT_REFRESH_TTL_DAYS=30
APP_URL=http://localhost:3000                 # base de los links del mail

SMTP_HOST=smtp.gmail.com                      # vacío = no envía, loguea
SMTP_PORT=587
SMTP_USER=tu-cuenta@gmail.com
SMTP_PASSWORD=<contraseña de aplicación>
SMTP_FROM=CPS Security <tu-cuenta@gmail.com>  # si falta, usa SMTP_USER
```

## Pendiente

- 2FA (TOTP) para OWNER — obligatorio por diseño cuando se implemente.
