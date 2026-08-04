# Puesta en marcha local (Windows)

> Cómo levantar el proyecto entero desde cero en una máquina nueva.
> Verificado el 2026-07-30 sobre Windows 11 + PostgreSQL 18 + Node 22.20.

---

## 1. Requisitos

| Qué | Versión | Nota |
|---|---|---|
| Node.js | **≥ 20.19 o ≥ 22.12** | Angular 21 rechaza versiones menores con un error explícito. Con `nvm-windows`: `nvm use 22.20.0`. |
| npm | 10.x | viene con Node |
| PostgreSQL | 18 | el servicio `postgresql-x64-18` tiene que estar corriendo |
| Git | cualquiera | |

`psql` no suele estar en el PATH; está en
`C:\Program Files\PostgreSQL\18\bin\psql.exe`.

## 2. Clonar

```powershell
git clone https://github.com/CPSSecurity27/system-web.git
cd system-web
```

## 3. Instalar dependencias

Ojo: `npm --prefix <ruta> install` **no funciona** acá (npm igual busca el
`package.json` del directorio actual). Hay que entrar a cada carpeta.

```powershell
cd backend-nestjs;   npm install; cd ..
cd frontend-angular; npm install; cd ..
```

## 4. Configurar el backend

```powershell
cd backend-nestjs
copy .env.example .env
```

Editar `.env`. Lo mínimo para que arranque en local:

- `DB_USER=cps_web` / `DB_PASSWORD=CpsWeb2026!` — el rol de aplicación que crea el
  script del paso 5 (la base misma le impide escribir `device_state` y tocar lo
  append-only).
- `DB_MIGRATIONS_USER=postgres` / `DB_MIGRATIONS_PASSWORD=<clave de postgres>` —
  las migraciones necesitan DDL, así que el CLI de TypeORM usa credenciales admin.
- `JWT_SECRET` y `REMOTE_CODES_KEY` — **generar propios, nunca reusar los del
  ejemplo**:

  ```powershell
  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"  # JWT_SECRET
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"     # REMOTE_CODES_KEY
  ```

- `SMTP_HOST=` vacío — en local alcanza: los mails no se envían, se loguean por
  consola (el link de activación de vecino sale ahí).
- `FRONTEND_URL=http://localhost:4200` — es a donde apunta el link de reseteo de
  contraseña. El `.env.example` trae `5173`, que no es el puerto de `ng serve`.

`.env` está en `.gitignore`: nunca se commitea.

## 5. Crear la base

La base tiene que ser **NUEVA**: la migración es un esquema inicial completo y los
datos de versiones anteriores no pasan los CHECK actuales.

```powershell
$env:PGPASSWORD="<clave de postgres>"
$psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"

& $psql -U postgres -h localhost -d postgres -c "CREATE DATABASE cps_security_v2"
```

## 6. Migraciones, roles, usuarios y geografía

En ese orden — los roles se aplican **después** de la migración porque otorgan
permisos sobre tablas que todavía no existen.

```powershell
cd backend-nestjs

npm run migration:run          # las 15 migraciones (ver backend-nestjs/docs/migraciones.md)

# Roles de conexión (cps_web / cps_alarms). Idempotente, pero NO opcional:
# además de crear los roles, es lo que le saca a cps_alarms la escritura directa
# sobre device_state y event y reparte los EXECUTE de las funciones del esquema
# `gtd`. Sin esto, el contrato con el servicio de alarmas no lo impone nadie.
& $psql -U postgres -h localhost -d cps_security_v2 -f ..\docs\roles-conexion-v2.sql

# cuenta COMPANY "CPS Security" + OWNER institucional + ADMIN
npm run auth:bootstrap -- cps_root <clave_fuerte> ale_copa <clave> mail@cps.com

# provincias / departamentos / localidades desde georef (necesita internet)
npm run geography:sync         # ~24 provincias, 529 departamentos, 4026 localidades
```

## 7. Levantar

Dos terminales:

```powershell
cd backend-nestjs;   npm run start:dev   # http://localhost:3000/api  — Swagger en /api/docs
cd frontend-angular; npm start           # http://localhost:4200
```

## 8. Verificar que anda

```powershell
$b = @{ identifier='ale_copa'; password='<la clave del bootstrap>' } | ConvertTo-Json
$r = Invoke-RestMethod http://localhost:3000/api/auth/login -Method Post -Body $b -ContentType application/json
$h = @{ Authorization = "Bearer $($r.accessToken)" }
Invoke-RestMethod http://localhost:3000/api/plans -Headers $h
```

Tiene que devolver los dos planes semilla (`COMUNITARIA_BASE`, `MUNICIPAL_BASE`).
Con eso ya sabés que andan la conexión a la base, el hash de contraseñas, el JWT y
los guards. Después, entrar a http://localhost:4200 y loguearse con el mismo
usuario.

El login usa un campo único `identifier`: acepta username, email o DNI.

## 9. Verificación del código (antes de commitear)

```powershell
cd backend-nestjs
npx tsc --noEmit; npx eslint "src/**/*.ts"; npm test

cd ..\frontend-angular
npm test
```

## 10. Problemas conocidos

| Síntoma | Causa | Solución |
|---|---|---|
| `The Angular CLI requires a minimum Node.js version of v20.19` | Node viejo | `nvm use 22.20.0` y abrir una terminal nueva |
| `ENOENT ... open 'system-web\package.json'` en el install | se usó `npm --prefix` | entrar a la carpeta con `cd` |
| `psql: no se reconoce` | PostgreSQL no está en el PATH | invocarlo con la ruta completa |
| `psql` se queda colgado sin devolver nada | está pidiendo la contraseña por consola | `$env:PGPASSWORD="<clave>"` antes de invocarlo |
| Una clave con `ñ`/acentos no anda al loguearse | se pasó por línea de comandos y Windows la mutiló | cargarla por el formulario o por archivo, nunca por `argv` |
| El backend arranca pero todo da 500 de permisos | falta correr `roles-conexion-v2.sql` | correrlo (paso 6) |
| Migraciones fallan por CHECK constraints | la base tenía datos viejos | borrar la base y rehacerla desde cero (paso 5) |
| No llega ningún mail | `SMTP_HOST` vacío | es lo esperado en local: el link sale por la consola del backend |

## 11. Empezar de nuevo

```powershell
& $psql -U postgres -h localhost -d postgres -c "DROP DATABASE cps_security_v2"
```

Y repetir desde el paso 5.
