-- ============================================================================
-- CPS Security — Esquema PostgreSQL v2 (base de datos NUEVA)
-- Fecha: 2026-07-16 · Estado: diseño Fase 2, listo para revisión
-- Fuente de las decisiones: docs/diseno-relaciones-fase1.md y docs/negocio-redisenado.md
--
-- Principios que este esquema impone POR SÍ MISMO (no dependen del código):
--   1. La alarma es del barrio; el control es del hogar; el portador es reasignable.
--   2. Todo cliente es una ORGANIZATION con exactamente un OWNER y contrato por barrio.
--   3. Los cupos son columnas que solo CPS escribe (permiso de app + auditoría).
--   4. Un solo escritor por tabla entre la web y el servicio de alarmas (GRANTs, §12).
--   5. La historia no se borra: eventos y auditoría son append-only.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Tipos ENUM (espejarlos en common/enums.ts del backend)
-- ----------------------------------------------------------------------------

CREATE TYPE account_type      AS ENUM ('COMPANY', 'ORGANIZATION');
-- Solo la ESCALA del cliente: MUNICIPAL = varios barrios, COMMUNITY = uno.
-- Quién OPERA cada barrio es otra pregunta y vive en neighborhood.managed_by.
-- (Se llamaba PRIVATE hasta 2026-07-30 — migración AccountPlansAndRoleQuotas.)
CREATE TYPE org_subtype       AS ENUM ('MUNICIPAL', 'COMMUNITY');
CREATE TYPE user_role         AS ENUM ('OWNER', 'ADMIN', 'TECHNICIAN', 'MONITOR');
CREATE TYPE user_kind         AS ENUM ('PERSON', 'INSTITUTIONAL');
CREATE TYPE entity_status     AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');
CREATE TYPE managed_by_type   AS ENUM ('CPS', 'ORGANIZATION');
CREATE TYPE home_member_role  AS ENUM ('TITULAR', 'FAMILIAR');
CREATE TYPE contract_status   AS ENUM ('ACTIVE', 'SUSPENDED', 'EXPIRED', 'CANCELLED');
CREATE TYPE device_type       AS ENUM ('COMMUNITY_ALARM', 'SIREN', 'REPEATER', 'SENSOR');
-- INSTALLED se eliminó (2026-07-31): era lo mismo que OPERATIONAL y estaba
-- muerto — el backend nunca lo escribió.
CREATE TYPE device_status     AS ENUM ('INVENTORY', 'OPERATIONAL',
                                       'MAINTENANCE', 'OUT_OF_SERVICE', 'RETIRED');
-- Cómo se supo de un hito del equipo: lo vio el broker o lo marcó una persona.
CREATE TYPE device_milestone_source AS ENUM ('OBSERVED', 'MANUAL');
CREATE TYPE maintenance_type  AS ENUM ('INSTALL', 'SERVICE', 'REPAIR', 'CHECK', 'REPLACE');
CREATE TYPE maintenance_status AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'CANCELLED');
CREATE TYPE remote_status     AS ENUM ('INVENTORY', 'ACTIVE', 'SUSPENDED', 'LOST',
                                       'REPLACED', 'CLOSED');
CREATE TYPE event_origin      AS ENUM ('APP', 'REMOTE', 'DEVICE', 'PANEL');
CREATE TYPE event_scope       AS ENUM ('SINGLE', 'COMMUNITY');
CREATE TYPE event_status      AS ENUM ('OPEN', 'RESOLVED', 'FALSE_ALARM');
                                       -- ACKNOWLEDGED pospuesto (M5): agregarlo después
                                       -- es un ALTER TYPE ... ADD VALUE, no rompe nada
CREATE TYPE location_mode     AS ENUM ('LIVE', 'FIXED');
CREATE TYPE user_token_type   AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET', 'PHONE_OTP');
CREATE TYPE user_device_status AS ENUM ('ACTIVE', 'REVOKED');

-- updated_at automático (mismo patrón que el esquema v1)
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ----------------------------------------------------------------------------
-- 1. Geografía (read-only, sincronizada desde la API de georef)
--    georef_id es TEXT: los códigos llevan ceros a la izquierda ("06", "06021")
-- ----------------------------------------------------------------------------

CREATE TABLE province (
  id         SERIAL PRIMARY KEY,
  georef_id  TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE department (
  id          SERIAL PRIMARY KEY,
  georef_id   TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  province_id INT NOT NULL REFERENCES province(id) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_department_province ON department(province_id);

CREATE TABLE locality (
  id            SERIAL PRIMARY KEY,
  georef_id     TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  department_id INT NOT NULL REFERENCES department(id) ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_locality_department ON locality(department_id);

-- ----------------------------------------------------------------------------
-- 2. Personas — app_user (una sola tabla para panel y app de vecinos)
--    ("user" es palabra reservada en PostgreSQL, por eso app_user)
-- ----------------------------------------------------------------------------

CREATE TABLE app_user (
  id                SERIAL PRIMARY KEY,
  kind              user_kind NOT NULL DEFAULT 'PERSON',
  name              TEXT NOT NULL,            -- INSTITUTIONAL: nombre de la institución
  username          TEXT UNIQUE,              -- handle del panel (NULL para vecinos puros)
  dni               TEXT UNIQUE,              -- identidad del vecino (NULL para panel puro)
  email             TEXT UNIQUE,
  telephone         TEXT,
  birth_date        DATE,                     -- dato opcional del vecino
  password_hash     TEXT,                     -- argon2id; NULL = cuenta sin activar
  status            entity_status NOT NULL DEFAULT 'ACTIVE',
  email_verified_at TIMESTAMPTZ,
  phone_verified_at TIMESTAMPTZ,
  last_login_at     TIMESTAMPTZ,
  -- v2.2 (migración MustChangePassword, 2026-07-24): el OWNER institucional
  -- nace con una clave TEMPORAL generada por el sistema, no elegida por el
  -- admin de CPS que lo crea. Se apaga solo al cambiarla (AuthService#changePassword).
  must_change_password BOOLEAN NOT NULL DEFAULT false,
  created_by        INT REFERENCES app_user(id) ON DELETE SET NULL,  -- NULL: bootstrap
  updated_by        INT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Con algo hay que poder loguearse
  -- v2.1 (migración VecinoEmailLogin): el vecino ya no exige DNI, registra
  -- con email; alguna identidad de login tiene que existir siempre.
  CONSTRAINT chk_user_login_identity CHECK (username IS NOT NULL OR dni IS NOT NULL OR email IS NOT NULL),
  -- Un usuario institucional no tiene datos de persona
  CONSTRAINT chk_institutional_no_dni CHECK (kind <> 'INSTITUTIONAL' OR dni IS NULL)
);
CREATE TRIGGER trg_app_user_updated BEFORE UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- 3. Cuentas — el cliente (o CPS), su plan y sus cupos
-- ----------------------------------------------------------------------------

-- El catálogo comercial: qué cupos otorga cada plan que CPS vende.
--
-- Es una PLANTILLA, no una fuente de verdad. Al crear una cuenta los cupos se
-- COPIAN a las columnas max_* del account, y desde ahí son de esa cuenta.
--
-- Por qué no un plan_id que se lea en vivo, que sería más "normalizado": la
-- regla 4 del dominio dice que los cupos SOLO los modifica CPS, siempre con
-- audit_log y con grandfathering. Un plan leído en vivo bajaría el cupo de
-- cien clientes de una, sin una sola fila de auditoría y sin respetar lo ya
-- existente — las tres cosas que esa regla prohíbe. Es la misma decisión que
-- ya tomó service_contract al congelar el precio al firmar.
--
-- Es catálogo y no enum para que un plan nuevo sea un INSERT y no una
-- migración: la oferta comercial cambia más seguido que el esquema.
CREATE TABLE plan (
  id                      SERIAL PRIMARY KEY,
  code                    TEXT NOT NULL UNIQUE,   -- identificador estable: 'MUNICIPAL_BASE'
  name                    TEXT NOT NULL,          -- el de vidriera, cambia sin avisar
  description             TEXT,

  -- A qué clase de organización aplica. Un plan municipal ofrecido a una
  -- comunitaria (o al revés) sería un error de venta silencioso.
  applies_to              org_subtype NOT NULL,

  -- Precio de REFERENCIA (lista). El que se COBRA es el del service_contract,
  -- congelado al firmar; este es el de la vidriera.
  price_reference         NUMERIC(12,2),
  active                  BOOLEAN NOT NULL DEFAULT true,  -- false = discontinuado

  -- Cupos de ORGANIZACIÓN que otorga
  max_neighborhoods       INT NOT NULL CHECK (max_neighborhoods >= 1),
  max_admin_users         INT NOT NULL CHECK (max_admin_users >= 0),
  max_technician_users    INT NOT NULL CHECK (max_technician_users >= 0),
  max_monitor_users       INT NOT NULL CHECK (max_monitor_users >= 0),

  -- Cupos de BARRIO que sugiere
  max_family_members      INT NOT NULL DEFAULT 3 CHECK (max_family_members >= 0),
  community_scope_enabled BOOLEAN NOT NULL DEFAULT true,

  created_by              INT REFERENCES app_user(id) ON DELETE SET NULL,
  updated_by              INT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_plan_code CHECK (code ~ '^[A-Z0-9_]{2,32}$'),
  -- La invariante de la comunitaria, también acá: sin esto se podría armar un
  -- plan COMMUNITY de 5 barrios que recién rebota al momento de venderlo.
  CONSTRAINT chk_plan_community_single_neighborhood CHECK (
    applies_to <> 'COMMUNITY' OR max_neighborhoods = 1
  )
);
CREATE TRIGGER trg_plan_updated BEFORE UPDATE ON plan
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO plan (
  code, name, description, applies_to,
  max_neighborhoods, max_admin_users, max_technician_users, max_monitor_users
) VALUES
  ('COMUNITARIA_BASE', 'Comunitaria Base',
   'Un barrio, gestión de CPS o propia. El trabajo de campo lo hace CPS: sin técnicos propios.',
   'COMMUNITY', 1, 2, 0, 1),
  ('MUNICIPAL_BASE', 'Municipal Base',
   'Autogestión: varios barrios, personal propio de campo y de monitoreo.',
   'MUNICIPAL', 10, 5, 5, 5);

CREATE TABLE account (
  id                 SERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  type               account_type NOT NULL,
  subtype            org_subtype,             -- solo ORGANIZATION
  status             entity_status NOT NULL DEFAULT 'ACTIVE',

  -- De qué plan salieron los cupos al crear la cuenta. REFERENCIA HISTÓRICA:
  -- sirve para "¿cuántos clientes hay en cada plan?" y NADA más. Los cupos
  -- vigentes son las columnas de abajo (ver tabla plan más adelante).
  plan_id            INT REFERENCES plan(id) ON DELETE SET NULL,

  -- CUPOS (§5.2 del diseño): SOLO CPS los escribe (permiso de app + audit_log).
  -- Solo tienen sentido en ORGANIZATION, y ahí son OBLIGATORIOS (lo exige el
  -- CHECK de abajo): no existe "sin límite" (2026-07-23). NULL solo aparece en
  -- COMPANY, donde el cupo directamente no aplica: CPS no se cobra a sí misma.
  --
  -- Los tres cupos de PERSONAL usan el 0 con sentido: cupo 0 = ese rol NO
  -- EXISTE en esta cuenta. Con eso, "una comunitaria no tiene técnicos propios
  -- porque el campo lo hace CPS" se dice con el mismo mecanismo que el resto
  -- de la tarifa, en vez de con una matriz de roles-por-tipo aparte.
  max_neighborhoods    INT CHECK (max_neighborhoods >= 0),
  max_admin_users      INT CHECK (max_admin_users >= 0),
  max_technician_users INT CHECK (max_technician_users >= 0),
  max_monitor_users    INT CHECK (max_monitor_users >= 0),

  -- CUPOS DE BARRIO (migración AccountNeighborhoodQuotas). No son un techo de
  -- la cuenta: son el valor que se COPIA a cada barrio nuevo suyo. Después,
  -- cada barrio puede apartarse por PATCH /neighborhoods/:id/quotas.
  --
  -- Viven acá, en el medio, y NO se leen del plan al crear el barrio: el plan
  -- es una plantilla que se copia al vender y nunca se lee en vivo (regla 4).
  --   plan (plantilla) -> account (lo vendido) -> neighborhood (lo aplicado)
  max_family_members      INT,
  community_scope_enabled BOOLEAN,
  CONSTRAINT chk_account_max_family_members
    CHECK (max_family_members IS NULL OR max_family_members >= 0),

  -- JURISDICCIÓN (migración AccountJurisdictionAndAccountContracts): hasta
  -- dónde llega el cliente. Sus barrios solo se crean DENTRO de este límite.
  -- Va exactamente uno de los dos ids, el que corresponda al nivel.
  -- NULL en COMPANY: CPS no tiene territorio.
  jurisdiction_level jurisdiction_level,
  locality_id        INT REFERENCES locality(id) ON DELETE RESTRICT,
  department_id      INT REFERENCES department(id) ON DELETE RESTRICT,

  -- DÓNDE ESTÁ el cliente en el mapa. OBLIGATORIA en ORGANIZATION desde la
  -- migración MandatoryCoordinates (lo exige chk_subtype_by_type, más abajo):
  -- el tablero de clientes es un mapa, y con pines faltantes no se puede leer.
  --   MUNICIPAL → la sede de la municipalidad
  --   COMMUNITY → el punto de su único barrio (son el mismo lugar)
  --   COMPANY   → NULL
  -- Ubica al cliente; lo que acota dónde puede crear barrios es la
  -- jurisdicción, no este punto. NO es un cupo: no va por /quotas.
  latitude           DOUBLE PRECISION,
  longitude          DOUBLE PRECISION,

  created_by         INT REFERENCES app_user(id) ON DELETE SET NULL,
  updated_by         INT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Habilita las FK compuestas de neighborhood y service_contract (no borrar)
  CONSTRAINT uq_account_id_type UNIQUE (id, type),
  -- ORGANIZATION lleva subtype, los CUATRO cupos y su punto en el mapa;
  -- COMPANY, ninguna de las tres cosas.
  --
  -- Las coordenadas viajan en ESTE constraint y no en uno propio a propósito:
  -- dos CHECK sobre las mismas columnas se contradicen apenas se toca uno solo.
  CONSTRAINT chk_subtype_by_type CHECK (
    (type = 'ORGANIZATION'
      AND subtype IS NOT NULL
      AND max_neighborhoods IS NOT NULL
      AND max_admin_users IS NOT NULL
      AND max_technician_users IS NOT NULL
      AND max_monitor_users IS NOT NULL
      AND max_family_members IS NOT NULL
      AND community_scope_enabled IS NOT NULL
      AND latitude IS NOT NULL
      AND longitude IS NOT NULL)
    OR
    (type = 'COMPANY'
      AND subtype IS NULL
      AND plan_id IS NULL
      AND max_neighborhoods IS NULL
      AND max_admin_users IS NULL
      AND max_technician_users IS NULL
      AND max_monitor_users IS NULL
      AND max_family_members IS NULL
      AND community_scope_enabled IS NULL)
  ),
  -- Toda ORGANIZATION tiene jurisdicción, y va EXACTAMENTE uno de los dos ids
  -- según el nivel. CPS (COMPANY) no tiene ninguno: no tiene territorio.
  CONSTRAINT chk_account_jurisdiction CHECK (
    (type = 'COMPANY'
      AND jurisdiction_level IS NULL
      AND locality_id IS NULL
      AND department_id IS NULL)
    OR
    (type = 'ORGANIZATION'
      AND ((jurisdiction_level = 'LOCALITY'
              AND locality_id IS NOT NULL
              AND department_id IS NULL)
        OR (jurisdiction_level = 'DEPARTMENT'
              AND department_id IS NOT NULL
              AND locality_id IS NULL)))
  )
);
-- CPS es una sola: no puede existir una segunda cuenta COMPANY
CREATE UNIQUE INDEX uq_account_single_company ON account (type) WHERE type = 'COMPANY';
CREATE TRIGGER trg_account_updated BEFORE UPDATE ON account
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- 4. Membresías del panel — account_user
--    (ya sin copia de account_type: con HOME eliminado, los 4 roles valen en
--     ambos tipos de cuenta y el CHECK de matriz quedó vacío)
--
--    v2.2 (migración SingleAccountMembership, 2026-07-24): una persona
--    pertenece a UNA sola cuenta a la vez — UNIQUE(user_id), no compuesto.
--    El caso "operador compartido entre dos clientes" quedó descartado: no
--    se va a dar en la práctica y complicaba el padrón sin necesidad.
-- ----------------------------------------------------------------------------

CREATE TABLE account_user (
  id         SERIAL PRIMARY KEY,
  account_id INT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  user_id    INT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role       user_role NOT NULL,
  created_by INT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A lo sumo UNA membresía por persona (no compuesto con account_id)
  CONSTRAINT uq_account_user_single_account UNIQUE (user_id),
  -- Habilita la FK compuesta de staff_assignment (no borrar)
  CONSTRAINT uq_account_user_id_account UNIQUE (id, account_id)
);
-- Exactamente un OWNER por cuenta
CREATE UNIQUE INDEX uq_account_single_owner ON account_user(account_id)
  WHERE role = 'OWNER';
-- idx_account_user_user ya no hace falta: uq_account_user_single_account
-- crea su propio índice único sobre user_id.
CREATE INDEX idx_account_user_account ON account_user(account_id);
CREATE TRIGGER trg_account_user_updated BEFORE UPDATE ON account_user
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Invariantes que van en el SERVICIO (la base no llega):
--   * el usuario con rol OWNER debe ser kind = INSTITUTIONAL, y viceversa
--   * un INSTITUTIONAL solo puede tener membresías OWNER
--   * cupo POR ROL al crear o promover: ADMIN -> max_admin_users,
--     TECHNICIAN -> max_technician_users, MONITOR -> max_monitor_users.
--     Cupo 0 = ese rol no existe en la cuenta (mensaje distinto al de cupo
--     agotado: uno se amplía, el otro hay que contratarlo). El OWNER no tiene
--     cupo: es único por índice, no por tarifa.
--   * toda cuenta conserva su OWNER (no se borra la última soberanía)

-- ----------------------------------------------------------------------------
-- 5. Barrio — la unidad operativa, con su organización cliente y sus cupos
-- ----------------------------------------------------------------------------

CREATE TABLE neighborhood (
  id                      SERIAL PRIMARY KEY,
  name                    TEXT NOT NULL,
  -- Código corto que viaja al equipo como `central.grupo`. El firmware trunca
  -- en 15 caracteres: "Barrio Parque Los Aromos" no entra. El nombre largo se
  -- queda en la web; esto es lo que ve el panel.
  code                    TEXT NOT NULL,
  CONSTRAINT uq_neighborhood_code UNIQUE (code),
  CONSTRAINT chk_neighborhood_code CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{0,14}$'),
  status                  entity_status NOT NULL DEFAULT 'ACTIVE',
  locality_id             INT NOT NULL REFERENCES locality(id) ON DELETE RESTRICT,

  -- OBLIGATORIAS desde la migración MandatoryCoordinates. El barrio sale en el
  -- tablero de clientes y en el mapa del monitoreo. Cierra además una
  -- incoherencia: la VIVIENDA ya estaba obligada a tener GPS (tabla home) y el
  -- barrio que la contiene, no. No es un cupo: la carga cualquier gestor.
  latitude                DOUBLE PRECISION NOT NULL,
  longitude               DOUBLE PRECISION NOT NULL,

  -- La organización cliente (muni o consorcio). La columna organization_type
  -- es redundancia CONTROLADA POR LA BASE: fijada en 'ORGANIZATION' por el CHECK
  -- y atada con FK compuesta -> una cuenta COMPANY no puede ser dueña de barrios.
  organization_id         INT NOT NULL,
  organization_type       account_type NOT NULL DEFAULT 'ORGANIZATION',
  CONSTRAINT chk_neighborhood_org_type CHECK (organization_type = 'ORGANIZATION'),
  CONSTRAINT fk_neighborhood_org FOREIGN KEY (organization_id, organization_type)
    REFERENCES account(id, type) ON DELETE RESTRICT,

  -- QUIÉN OPERA este barrio: CPS (vendido llave en mano) o su propia
  -- organización (autogestión). Se decide barrio por barrio y es la MODALIDAD
  -- DE VENTA, no una consecuencia del subtipo de la cuenta (2026-07-30): una
  -- comunitaria puede autogestionarse y una municipal puede tercerizarle un
  -- barrio a CPS teniendo los otros nueve propios. Derivarlo del subtipo hacía
  -- imposibles los dos casos.
  --
  -- Con managed_by = CPS, el personal de la organización dueña VE el barrio
  -- entero (lo paga, necesita sus eventos y su estado) pero no lo gestiona: ni
  -- el barrio, ni sus viviendas, ni sus vecinos. Lo impone ScopeService
  -- (managesNeighborhood), en un solo lugar para todos los módulos. El TITULAR
  -- de un hogar queda al margen: su casa la administra él, la opere quien la opere.
  managed_by              managed_by_type NOT NULL,

  -- CUPOS del barrio (§5.2): SOLO CPS los escribe
  max_family_members      INT NOT NULL DEFAULT 3 CHECK (max_family_members >= 0),
  -- ACTIVACIÓN COMUNITARIA: el permiso del vecino para salirse de la alarma
  -- preferida de su hogar. Cubre las dos formas de hacerlo — disparar TODAS
  -- las del barrio a la vez (eventos scope=COMMUNITY) o elegir UNA distinta de
  -- la suya. Apagado, el vecino solo puede disparar la de su vivienda.
  --
  -- Es UN permiso y no dos (2026-08-03): separarlos permitía la combinación
  -- incoherente "no puede elegir una alarma lejana, pero sí dispararla junto
  -- con todas las demás".
  community_scope_enabled BOOLEAN NOT NULL DEFAULT true,

  created_by              INT REFERENCES app_user(id) ON DELETE SET NULL,
  updated_by              INT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Habilita la FK compuesta de staff_assignment (no borrar)
  CONSTRAINT uq_neighborhood_id_org UNIQUE (id, organization_id)
);
CREATE INDEX idx_neighborhood_locality ON neighborhood(locality_id);
CREATE INDEX idx_neighborhood_org      ON neighborhood(organization_id);
CREATE TRIGGER trg_neighborhood_updated BEFORE UPDATE ON neighborhood
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Servicio: cupo max_neighborhoods al crear; transferencia = UPDATE organization_id
-- + managed_by, SOLO CPS, siempre con fila en audit_log.

-- ----------------------------------------------------------------------------
-- 6. Personal acotado por barrio — staff_assignment
--    Sin filas = ve todos los barrios de su organización. Con filas = solo esos.
--    Las DOS FK compuestas comparten account_id/organization_id: asignar a un
--    miembro un barrio de OTRA organización es imposible a nivel base.
-- ----------------------------------------------------------------------------

CREATE TABLE staff_assignment (
  id              SERIAL PRIMARY KEY,
  account_user_id INT NOT NULL,
  account_id      INT NOT NULL,
  neighborhood_id INT NOT NULL,
  created_by      INT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_staff_assignment UNIQUE (account_user_id, neighborhood_id),
  CONSTRAINT fk_sa_membership FOREIGN KEY (account_user_id, account_id)
    REFERENCES account_user(id, account_id) ON DELETE CASCADE,
  CONSTRAINT fk_sa_neighborhood FOREIGN KEY (neighborhood_id, account_id)
    REFERENCES neighborhood(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX idx_sa_neighborhood ON staff_assignment(neighborhood_id);

-- ----------------------------------------------------------------------------
-- 7. Comercial — service_contract (condiciones congeladas al firmar)
-- ----------------------------------------------------------------------------

CREATE TABLE service_contract (
  id              SERIAL PRIMARY KEY,
  price           NUMERIC(12,2) NOT NULL,   -- nunca DOUBLE: es dinero
  description     TEXT,
  start_date      DATE NOT NULL,
  end_date        DATE,                     -- NULL = abierto / autorrenovable
  status          contract_status NOT NULL DEFAULT 'ACTIVE',

  -- Solo una ORGANIZATION contrata (CPS presta el servicio; COMPANY no firma).
  account_id      INT NOT NULL,
  account_type    account_type NOT NULL DEFAULT 'ORGANIZATION',
  CONSTRAINT chk_contract_org_only CHECK (account_type = 'ORGANIZATION'),
  CONSTRAINT fk_contract_account FOREIGN KEY (account_id, account_type)
    REFERENCES account(id, type) ON DELETE RESTRICT,

  neighborhood_id INT NOT NULL REFERENCES neighborhood(id) ON DELETE RESTRICT,

  created_by      INT REFERENCES app_user(id) ON DELETE SET NULL,
  updated_by      INT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Un solo contrato ACTIVE por barrio (el 23505 se traduce a 409, no se pre-chequea)
CREATE UNIQUE INDEX uq_contract_active_per_neighborhood
  ON service_contract(neighborhood_id) WHERE status = 'ACTIVE';
CREATE INDEX idx_contract_account ON service_contract(account_id);
CREATE TRIGGER trg_contract_updated BEFORE UPDATE ON service_contract
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- 8. Activos — device (alarma comunitaria), su estado vivo y su bitácora
-- ----------------------------------------------------------------------------

-- Catálogo de modelos de placa. El número de cada placa viene IMPRESO de fábrica
-- como <code><4 dígitos> (ALOY0043): acá vive el prefijo, en device.board_seq el
-- número. Es catálogo y no enum para que un modelo nuevo sea un INSERT y no una
-- migración, y para poder colgarle atributos de hardware cuando aparezcan.
-- El CHECK valida la FORMA y no la familia: clavar 'ALOY' bloquearía una placa
-- de otro proveedor sin comprar nada a cambio.
CREATE TABLE board_model (
  id         SERIAL PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,      -- 'ALOY' — solo el prefijo, sin dígitos
  name       TEXT NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT true,  -- false = discontinuado
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_board_model_code CHECK (code ~ '^[A-Z]{2,8}$')
);
INSERT INTO board_model (code, name) VALUES ('ALOY', 'ALOY');

CREATE TABLE device (
  id              SERIAL PRIMARY KEY,
  -- Identidad física, no se cambia. En una COMMUNITY_ALARM no se elige: es
  -- 'AV-' || mac, y ese string ES el usuario MQTT y el <id> del tópico
  -- (av/AV-A842E38FCA6C/status) — el JOIN con el servicio de alarmas.
  serial          TEXT NOT NULL UNIQUE,
  type            device_type NOT NULL DEFAULT 'COMMUNITY_ALARM',
  status          device_status NOT NULL DEFAULT 'INVENTORY',
  name            TEXT,                     -- "Esquina Norte" (al instalar)

  -- Provisioning (nace en fábrica CPS)
  claim_code      TEXT,                     -- el técnico lo usa para reclamar
  manufactured_at TIMESTAMPTZ,
  tested          BOOLEAN NOT NULL DEFAULT false,
  imei            TEXT,
  iccid           TEXT,
  mac             TEXT,                     -- MAC STA: 12 hex MAYÚSCULAS, sin ":"
  board_model_id  INT REFERENCES board_model(id) ON DELETE RESTRICT,
  board_seq       INT,                      -- 43 para "ALOY0043"; el string se compone

  -- Cuándo se cargó la credencial MQTT en el broker. NULL = está en inventario
  -- pero TODAVÍA NO puede conectarse. Hoy nadie la escribe: la derivación
  -- HMAC-SHA256(SALT_MQTT, MAC) está bloqueada porque falta el salt de
  -- producción del lado servidor (punto abierto PA4 del GtD), así que el alta
  -- solo muestra el comando pendiente. La columna nace igual para no migrar
  -- filas después y para poder listar los equipos a medio provisionar.
  mqtt_provisioned_at TIMESTAMPTZ,
  mqtt_provisioned_by INT REFERENCES app_user(id) ON DELETE SET NULL,

  -- Hitos de puesta en marcha. La ETAPA del equipo se DERIVA del último hito
  -- alcanzado (creado -> provisionado -> etiquetado -> 1ª conexión); no hay
  -- columna de etapa porque sería un segundo lugar donde vive el mismo dato,
  -- libre de contradecir a las fechas.
  labeled_at      TIMESTAMPTZ,              -- etiqueta impresa y pegada
  labeled_by      INT REFERENCES app_user(id) ON DELETE SET NULL,
  -- La primera conexión es un hecho OBSERVADO por el broker (regla 5: el
  -- estado vivo lo escribe el servicio de alarmas). Mientras el GtD no exista,
  -- CPS puede marcarla a mano — y entonces queda dicho que fue a mano.
  first_connection_at     TIMESTAMPTZ,
  first_connection_source device_milestone_source,
  first_connection_by     INT REFERENCES app_user(id) ON DELETE SET NULL,

  -- Custodia: en INVENTORY puede estar en stock de una organización
  -- (NULL = fábrica CPS). Instalado, pertenece a un barrio.
  organization_id INT REFERENCES account(id) ON DELETE RESTRICT,
  neighborhood_id INT REFERENCES neighborhood(id) ON DELETE RESTRICT,
  latitude        DOUBLE PRECISION,
  longitude       DOUBLE PRECISION,
  installed_at    TIMESTAMPTZ,

  -- Datos de INSTALACIÓN (2026-07-31). Lo que un técnico necesita saber ANTES
  -- de subirse a la escalera. Todos OPCIONALES —nadie mide la altura colgado de
  -- una escalera— pero recomendados, y editables después.
  --
  -- Columnas dedicadas y no un JSONB: así se puede preguntar "¿qué alarma está
  -- en el poste 42?" o "¿cuáles cuelgan del tablero de la plaza?", que es lo que
  -- sirve cuando hay que ir a arreglar algo.
  pole_number     TEXT,                     -- número de poste o columna
  height_m        NUMERIC(4,1),             -- altura de montaje, en metros
  reference       TEXT,                     -- la esquina, entre qué calles
  power_point     TEXT,                     -- de qué luminaria o tablero cuelga
  install_notes   TEXT,                     -- lo que no entra en los anteriores

  created_by      INT REFERENCES app_user(id) ON DELETE SET NULL,
  updated_by      INT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- INVENTORY <=> sin barrio; en servicio <=> con barrio
  CONSTRAINT chk_device_custody CHECK (
    (status = 'INVENTORY' AND neighborhood_id IS NULL)
    OR
    (status <> 'INVENTORY' AND neighborhood_id IS NOT NULL)
  ),
  -- El stock organizacional solo existe mientras está en inventario
  CONSTRAINT chk_device_stock_owner CHECK (
    status = 'INVENTORY' OR organization_id IS NULL
  ),
  -- Un solo formato canónico de MAC, o el UNIQUE no sirve de nada:
  -- 'a8:42:...' y 'A842...' serían dos filas del mismo equipo.
  CONSTRAINT chk_device_mac_format CHECK (
    mac IS NULL OR mac ~ '^[0-9A-F]{12}$'
  ),
  CONSTRAINT chk_device_board_seq CHECK (
    board_seq IS NULL OR (board_seq BETWEEN 1 AND 9999)
  ),
  -- Una altura de 0 o de 300 metros es un error de tipeo, no un dato.
  CONSTRAINT chk_device_height CHECK (
    height_m IS NULL OR (height_m > 0 AND height_m <= 30)
  ),
  -- La fecha de la primera conexión y su origen viajan juntos o no viajan.
  CONSTRAINT chk_device_first_connection CHECK (
    (first_connection_at IS NULL AND first_connection_source IS NULL)
    OR
    (first_connection_at IS NOT NULL AND first_connection_source IS NOT NULL)
  ),
  -- Un hito OBSERVADO no tiene autor humano; uno MANUAL sí, siempre.
  CONSTRAINT chk_device_first_connection_by CHECK (
    first_connection_source IS DISTINCT FROM 'MANUAL'
    OR first_connection_by IS NOT NULL
  ),
  -- Identidad de una alarma comunitaria. Que el serial ESTÉ atado a la MAC hace
  -- imposible que diverjan, ni por bug ni por un UPDATE a mano.
  CONSTRAINT chk_device_identity CHECK (
    type <> 'COMMUNITY_ALARM'
    OR (
      mac IS NOT NULL
      AND serial = 'AV-' || mac
      AND board_model_id IS NOT NULL
      AND board_seq IS NOT NULL
    )
  )
);
CREATE UNIQUE INDEX uq_device_claim_code ON device(claim_code)
  WHERE claim_code IS NOT NULL;
CREATE UNIQUE INDEX uq_device_mac ON device(mac) WHERE mac IS NOT NULL;
CREATE UNIQUE INDEX uq_device_board ON device(board_model_id, board_seq)
  WHERE board_model_id IS NOT NULL AND board_seq IS NOT NULL;
CREATE INDEX idx_device_neighborhood ON device(neighborhood_id);
CREATE TRIGGER trg_device_updated BEFORE UPDATE ON device
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Estado VIVO: una fila por device, UPDATE in place, SIN historial (el historial
-- es event). La escribe SOLO el servicio de alarmas (GRANTs en §12).
CREATE TABLE device_state (
  device_id      INT PRIMARY KEY REFERENCES device(id) ON DELETE CASCADE,
  online         BOOLEAN NOT NULL DEFAULT false,
  -- Catálogo del firmware (el viejo 'connected'/'trigger' era de Firebase y
  -- nunca se escribió):
  --   off | suspicious | alert | emergency | fire | medical | silent | panic
  alarm_status   TEXT,
  power_mode     TEXT,                      -- ACTIVE_240, MODEM_SLEEP, …
  -- Versión de configuración que el panel DICE estar corriendo. Vuelve a 0 tras
  -- un factory, y eso deja la gtd.panel_config en 'stale'.
  cfg_v          BIGINT NOT NULL DEFAULT 0,
  rf_gen         BIGINT NOT NULL DEFAULT 0, -- generación de la base RF del equipo
  fw             TEXT,                      -- llega por el cfg_full, no por el estado
  -- Voltajes en COLUMNAS y no en un JSONB (como los tenía el GtD), por lo mismo
  -- que los datos de instalación de `device`: es el dato de mantenimiento más
  -- importante de un poste y hay que poder preguntar "¿cuáles están por debajo
  -- de 11 V?" sin abrir un documento por fila.
  vbat           NUMERIC(5,2),
  vpanel         NUMERIC(5,2),
  vfuente        NUMERIC(5,2),
  -- last_seen lo pone el SERVIDOR (now() en upsert_panel_state): el reloj del
  -- panel puede estar días atrás con tsq>=2. Lo que el panel DECLARA va aparte:
  last_seen      TIMESTAMPTZ,               -- cuándo lo escuchamos (cualquier mensaje)
  last_heartbeat TIMESTAMPTZ,               -- el latido
  -- Hasta cuándo avisó que duerme (status durmiendo). NULL = no duerme. Un panel
  -- dormido figura online=false: esto distingue "duerme hasta las 7" de "se cayó
  -- a las 3 AM" — la diferencia entre despertar a un técnico y no.
  sleep_until    TIMESTAMPTZ,
  ts_device      TIMESTAMPTZ,               -- el reloj que el panel declara
  tsq            SMALLINT,                  -- calidad de ese reloj, 0..4, MENOR ES MEJOR
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_device_state_tsq CHECK (tsq IS NULL OR tsq BETWEEN 0 AND 4)
);
CREATE INDEX idx_device_state_vbat ON device_state(vbat) WHERE vbat IS NOT NULL;
-- Aviso a la web SOLO ante cambio real: sin el filtro, la cola de pg_notify se
-- llena y eso hace fallar los COMMIT, no solo las notificaciones. Voltaje y
-- last_seen NO notifican: para eso el tablero poll-ea (§14).
CREATE TRIGGER trg_panel_state_notify AFTER INSERT OR UPDATE ON device_state
  FOR EACH ROW EXECUTE FUNCTION gtd.notify_app_panel_state();

CREATE TABLE device_maintenance (
  id           SERIAL PRIMARY KEY,
  device_id    INT NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  type         maintenance_type NOT NULL,
  status       maintenance_status NOT NULL DEFAULT 'PENDING',
  description  TEXT,
  performed_at TIMESTAMPTZ,
  user_id      INT REFERENCES app_user(id) ON DELETE SET NULL,  -- el técnico
  created_by   INT REFERENCES app_user(id) ON DELETE SET NULL,
  updated_by   INT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_maintenance_device ON device_maintenance(device_id, created_at);
CREATE TRIGGER trg_maintenance_updated BEFORE UPDATE ON device_maintenance
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- 9. Hogar y sus miembros
--    (home va después de device por default_device_id)
-- ----------------------------------------------------------------------------

CREATE TABLE home (
  id                SERIAL PRIMARY KEY,
  -- La dirección IDENTIFICA la vivienda: no hay un `name` aparte. Con los dos
  -- campos el gestor escribía la dirección en el nombre y quedaban desfasados.
  address           TEXT NOT NULL,          -- "Mza A Casa 5"
  contact_phone     TEXT,                   -- teléfono DEL HOGAR (sobrevive al titular)
  status            entity_status NOT NULL DEFAULT 'ACTIVE',
  -- GPS OBLIGATORIO: sale en el mapa del monitoreo y en el `gps` del evento.
  latitude          DOUBLE PRECISION NOT NULL,
  longitude         DOUBLE PRECISION NOT NULL,
  neighborhood_id   INT NOT NULL REFERENCES neighborhood(id) ON DELETE RESTRICT,
  -- Alarma PREFERIDA para eventos SINGLE (preferencia, no propiedad).
  -- Servicio: debe ser un device del mismo barrio.
  default_device_id INT REFERENCES device(id) ON DELETE SET NULL,
  created_by        INT REFERENCES app_user(id) ON DELETE SET NULL,
  updated_by        INT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_home_neighborhood ON home(neighborhood_id);
CREATE TRIGGER trg_home_updated BEFORE UPDATE ON home
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- La relación vecino <-> vivienda NO vive en ninguna de las dos tablas: es una
-- fila propia acá. Ni `home.members`, ni `user.home_id`, ni `home.owner_id`
-- (los tres que tenía Firebase, diciendo lo mismo en tres lugares que nada
-- obligaba a mantener de acuerdo).
CREATE TABLE home_member (
  id         SERIAL PRIMARY KEY,
  home_id    INT NOT NULL REFERENCES home(id) ON DELETE CASCADE,
  user_id    INT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role       home_member_role NOT NULL,
  status     entity_status NOT NULL DEFAULT 'ACTIVE',
  created_by INT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Un solo TITULAR por hogar…
CREATE UNIQUE INDEX uq_home_single_titular ON home_member(home_id)
  WHERE role = 'TITULAR';
-- …y UNA PERSONA VIVE EN UNA SOLA CASA (titular o familiar, da igual). Es el
-- `user.home_id` de Firebase pero garantizado por la base. Sin esto, un vecino
-- en dos barrios hace ambiguo qué barrio despertar en un evento, y el cupo de
-- familiares se esquiva repartiendo gente entre hogares.
-- Subsume a uq_home_member (home_id,user_id) y a idx_home_member_user.
CREATE UNIQUE INDEX uq_home_member_one_home ON home_member(user_id);
CREATE TRIGGER trg_home_member_updated BEFORE UPDATE ON home_member
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Servicio: FAMILIAR nunca supera neighborhood.max_family_members al CREAR
-- (grandfathering si CPS baja el cupo). Un INSTITUTIONAL no puede ser home_member.

-- ----------------------------------------------------------------------------
-- 10. Controles remotos y sus códigos RF
-- ----------------------------------------------------------------------------

CREATE TABLE remote (
  id                  SERIAL PRIMARY KEY,
  name                TEXT NOT NULL,        -- "llavero cocina", "Control (stock)"
  status              remote_status NOT NULL DEFAULT 'INVENTORY',

  -- Custodia de 3 niveles: fábrica CPS -> stock org -> hogar (dueño)
  organization_id     INT REFERENCES account(id) ON DELETE RESTRICT,
  home_id             INT REFERENCES home(id) ON DELETE RESTRICT,
  -- Portador actual (puede no haber: "en el cajón de la casa")
  assigned_to_user_id INT REFERENCES app_user(id) ON DELETE SET NULL,
  -- Alarma donde están grabados sus códigos RF
  device_id           INT REFERENCES device(id) ON DELETE SET NULL,

  created_by          INT REFERENCES app_user(id) ON DELETE SET NULL,
  updated_by          INT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_remote_custody CHECK (
    (status = 'INVENTORY' AND home_id IS NULL)
    OR
    (status <> 'INVENTORY' AND home_id IS NOT NULL)
  ),
  CONSTRAINT chk_remote_stock_owner CHECK (
    status = 'INVENTORY' OR organization_id IS NULL
  )
);
CREATE INDEX idx_remote_home     ON remote(home_id);
CREATE INDEX idx_remote_assigned ON remote(assigned_to_user_id);
CREATE INDEX idx_remote_device   ON remote(device_id);
CREATE TRIGGER trg_remote_updated BEFORE UPDATE ON remote
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Servicio: portador ∈ miembros del hogar; device del mismo barrio que el hogar;
-- (el cupo remote_controls_enabled se eliminó el 2026-08-03: cualquier barrio
--  puede tener controles. Migración DropRemoteControlsQuota.)

CREATE TABLE remote_code (
  id             SERIAL PRIMARY KEY,
  remote_id      INT NOT NULL REFERENCES remote(id) ON DELETE CASCADE,
  -- AES-256-GCM: iv (12) || authTag (16) || ciphertext. La base NUNCA ve el claro.
  code_encrypted BYTEA NOT NULL,
  position       SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 4),  -- M2: 4 códigos
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_remote_code_position UNIQUE (remote_id, position)
);
CREATE INDEX idx_remote_code_remote ON remote_code(remote_id);

-- ----------------------------------------------------------------------------
-- 11. Eventos (append-only) — el corazón operativo. ILIMITADOS, sin cupo.
--     Candidata a particionar por created_at cuando el volumen lo pida.
-- ----------------------------------------------------------------------------

CREATE TABLE event (
  id                  BIGSERIAL PRIMARY KEY,
  neighborhood_id     INT NOT NULL REFERENCES neighborhood(id) ON DELETE RESTRICT,
  device_id           INT REFERENCES device(id) ON DELETE RESTRICT,
  home_id             INT REFERENCES home(id) ON DELETE RESTRICT,
  remote_id           INT REFERENCES remote(id) ON DELETE RESTRICT,

  origin              event_origin NOT NULL,
  scope               event_scope NOT NULL DEFAULT 'SINGLE',  -- descriptivo, sin cupo
  -- Catálogo del firmware, VERBATIM (el viejo cps001/cps002 era de Firebase):
  --   off | suspicious | alert | emergency | fire | medical | silent | panic
  trigger_mode        TEXT,
  -- El eid del panel (<boot_id>-<seq>). Su índice único parcial ES el dedup de
  -- la redistribución QoS 1: gtd.insert_evento devuelve false cuando choca y el
  -- GtD depende de ese booleano.
  external_id         TEXT,
  ts_device           TIMESTAMPTZ,           -- el ts que reportó el panel
  -- Calidad de ese reloj, 0..4. MENOR ES MEJOR (0=NTP, 1=DS3231, 2=piso en NVS,
  -- 3=RTC interno, 4=+6 h sin sync). Con tsq >= 2 hay que ordenar por
  -- created_at: el ts del equipo puede estar días atrasado y aun así ser
  -- "plausible" (el arranque MQTT está gateado por valor, no por calidad).
  tsq                 SMALLINT,
  CONSTRAINT chk_event_tsq CHECK (tsq IS NULL OR tsq BETWEEN 0 AND 4),
  gps_lat             DOUBLE PRECISION,
  gps_lng             DOUBLE PRECISION,
  location_mode       location_mode,

  -- SNAPSHOT congelado del activador: si el vecino cambia de teléfono, el evento
  -- histórico sigue mostrando el que era válido entonces (criterio "factura")
  activator_user_id   INT REFERENCES app_user(id) ON DELETE SET NULL,
  activator_name      TEXT,
  activator_phone     TEXT,

  status              event_status NOT NULL DEFAULT 'OPEN',
  resolved_by_user_id INT REFERENCES app_user(id) ON DELETE SET NULL,
  resolver_name       TEXT,                  -- snapshot, mismo criterio
  resolved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
  -- Append-only: sin updated_at. La web solo toca status/resolved_* al resolver.
);
CREATE INDEX idx_event_neighborhood ON event(neighborhood_id, created_at DESC);
CREATE INDEX idx_event_open ON event(neighborhood_id) WHERE status = 'OPEN';
CREATE INDEX idx_event_device ON event(device_id);
CREATE UNIQUE INDEX uq_event_external ON event(device_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE TABLE event_response (
  id         BIGSERIAL PRIMARY KEY,
  event_id   BIGINT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  user_id    INT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_event_response UNIQUE (event_id, user_id)
);

-- ----------------------------------------------------------------------------
-- 12. Sesiones, tokens, dispositivos de la app y auditoría
-- ----------------------------------------------------------------------------

CREATE TABLE refresh_token (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  ip_address TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_token_user ON refresh_token(user_id);

CREATE TABLE user_token (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  type       user_token_type NOT NULL,      -- incluye PHONE_OTP (login del vecino)
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,                   -- un solo uso
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_token_user ON user_token(user_id, type);

-- Un dispositivo móvil ACTIVO por persona (regla del PDF que se conserva):
-- registrar un teléfono nuevo revoca el anterior y sus refresh tokens.
CREATE TABLE user_device (
  id                 SERIAL PRIMARY KEY,
  user_id            INT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  platform           TEXT,                  -- 'android' | 'ios'
  device_fingerprint TEXT,
  fcm_token          TEXT,
  status             user_device_status NOT NULL DEFAULT 'ACTIVE',
  last_seen_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_user_device_active ON user_device(user_id)
  WHERE status = 'ACTIVE';

-- Append-only. Sin UPDATE ni DELETE (se refuerza con GRANTs).
-- Acciones que SIEMPRE auditan: reveal de códigos RF, transferencias de comunidad,
-- contratos, cambios de CUPOS (valor viejo -> nuevo), roles/membresías, suspensiones,
-- claim de equipos, credenciales y logins del OWNER.
CREATE TABLE audit_log (
  id            BIGSERIAL PRIMARY KEY,
  actor_user_id INT REFERENCES app_user(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,              -- 'contract.sign', 'quota.update', ...
  entity_type   TEXT NOT NULL,              -- 'neighborhood', 'remote_code', ...
  entity_id     BIGINT,
  account_id    INT,                        -- contexto, sin FK (histórico polimórfico)
  neighborhood_id INT,
  old_value     JSONB,
  new_value     JSONB,
  metadata      JSONB,
  ip_address    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_actor  ON audit_log(actor_user_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 13. Puente con el GtD (esquema `gtd`) — contrato por FUNCIONES
--     El servicio de alarmas NO toca ninguna tabla: llama funciones de acá, y
--     adentro decidimos a qué tabla va cada cosa. Así un cambio de mapeo es una
--     migración nuestra y no un deploy coordinado de dos servicios.
--     Detalle completo: docs/contrato-gtd-postgres.md
-- ----------------------------------------------------------------------------

CREATE SCHEMA gtd;

-- Cola de bajada (S->D). El NOTIFY 'gtd_commands' despierta al GtD.
CREATE TABLE gtd.commands (
  cid          TEXT PRIMARY KEY,
  mac          TEXT NOT NULL,
  device_id    INT  NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  tipo         TEXT NOT NULL,
  payload      JSONB NOT NULL,
  estado       TEXT NOT NULL DEFAULT 'pending',
  detalle      TEXT,
  requested_by INT REFERENCES app_user(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,

  CONSTRAINT chk_commands_estado CHECK (
    estado IN ('pending', 'sent', 'ok', 'error', 'cancelled')
  ),
  -- Los 13 del firmware (CmdType). Un typo es un comando que el panel descarta
  -- en silencio, así que se ataja en la base.
  CONSTRAINT chk_commands_tipo CHECK (
    tipo IN ('estado', 'restart', 'alarma', 'scan', 'test', 'ota',
             'factory', 'rf', 'refresh', 'hora', 'i2c_scan', 'red', 'cal')
  )
);
CREATE INDEX ix_commands_pending ON gtd.commands(mac) WHERE estado = 'pending';

-- Lo que LE MANDAMOS al panel (retained en av/<id>/cfg). cfg_v es ESTRICTAMENTE
-- creciente: el firmware ignora en silencio —sin ack, ni ok ni error— una
-- versión menor o igual a la que corre.
CREATE TABLE gtd.panel_config (
  mac        TEXT PRIMARY KEY,
  device_id  INT NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  cfg_v      BIGINT NOT NULL CHECK (cfg_v > 0),
  payload    JSONB  NOT NULL,
  estado     TEXT   NOT NULL DEFAULT 'pending',
  -- Por qué está en 'failed' (ej: "payload 1180 B > 1024"). Lo escribe
  -- gtd.mark_config_failed; publish_config lo limpia al republicar.
  detalle    TEXT,
  updated_by INT REFERENCES app_user(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Ciclo: pending -> sent -> applied | failed; 'stale' = el panel volvió a
  -- cfg_v 0 (factory) y hay que republicar completa. El trigger de NOTIFY solo
  -- dispara con pending/stale: 'failed' corta el loop.
  CONSTRAINT chk_panel_config_estado CHECK (
    estado IN ('pending', 'sent', 'applied', 'stale', 'failed')
  )
);
-- Para el barrido de gtd.fetch_pending_macs — mismo predicado que
-- fetch_pending_config; commands ya tiene el suyo (ix_commands_pending).
CREATE INDEX ix_panel_config_pending ON gtd.panel_config(mac)
  WHERE estado IN ('pending', 'stale');
CREATE TRIGGER trg_config_notify AFTER INSERT OR UPDATE ON gtd.panel_config
  FOR EACH ROW EXECUTE FUNCTION gtd.notify_gtd_config();
CREATE TRIGGER trg_commands_notify AFTER INSERT OR UPDATE ON gtd.commands
  FOR EACH ROW EXECUTE FUNCTION gtd.notify_gtd_commands();

-- El ESPEJO no es lo que mandamos: es lo que el panel DICE que corre. Los clamps
-- del firmware RECORTAN en silencio y ackean 'ok' (si mandás send_tele_s=5 el
-- panel guarda 30), así que esta es la única fuente confiable de qué config está
-- vigente — y la base del merge de gtd.publish_config.
CREATE TABLE gtd.config_espejo (
  mac        TEXT PRIMARY KEY,
  device_id  INT NOT NULL REFERENCES device(id) ON DELETE CASCADE,
  cfg_v      BIGINT NOT NULL,
  payload    JSONB  NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dead letter. NO es opcional: event.neighborhood_id es NOT NULL, así que una
-- alarma de un equipo en INVENTORY no se puede insertar. Sin esto, se pierde.
-- También recibe el DESARME (t:alarma con mode:"off"), que a propósito no crea
-- ni resuelve evento.
CREATE TABLE gtd.uplink_raw (
  id          BIGSERIAL PRIMARY KEY,
  mac         TEXT NOT NULL,
  tipo        TEXT NOT NULL,
  eid         TEXT,
  payload     JSONB NOT NULL,
  ts_device   TIMESTAMPTZ,
  tsq         SMALLINT,
  resultado   TEXT NOT NULL,  -- unknown_device | orphan | sin_destino | desarme
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_uplink_raw_mac ON gtd.uplink_raw(mac, received_at DESC);

-- Las FUNCIONES (todas SECURITY DEFINER, con search_path fijo). Ver la
-- migración GtdBridgeFunctions para el cuerpo.
--
--   ENTRADA (cps_alarms) — 1:1 con el Protocol Repo del GtD (firma v2,
--   2026-08-04, respuestas al doc 06):
--     gtd.upsert_panel_state(mac, estado, modo_energia, alarma_mode, cfg_v,
--                            rf_gen, energia, fw, despierta, ts_device, tsq,
--                            seen) -> text
--        estado: 'online'|'durmiendo'|'offline' (NULL = no tocar; online se
--        deriva). last_seen lo pone el servidor; seen=false = watchdog (el
--        panel NO habló, last_seen no se toca).
--     gtd.insert_evento(mac, tipo, payload, eid, ts) -> boolean  (false = dup)
--     gtd.confirm_command(cid, res, det) -> text
--     gtd.upsert_config_espejo(mac, cfg_v, payload) -> text
--     gtd.fetch_pending_commands(mac) -> setof (cid, tipo, payload)
--     gtd.fetch_pending_config(mac)   -> (cfg_v, payload)
--     gtd.fetch_pending_macs()        -> setof (mac, canal)   (el barrido P0-1)
--     gtd.mark_command_sent(cid) -> text
--     gtd.mark_config_sent(mac, cfg_v) -> text
--     gtd.mark_config_failed(mac, cfg_v, det) -> text   (la cfg que no salió, P0-2)
--
--   SALIDA (cps_web) — atomicidad y auditoría, no aislamiento:
--     gtd.enqueue_command(device_id, tipo, params, user_id) -> cid
--     gtd.publish_config(device_id, patch, user_id) -> cfg_v
--     gtd.cancel_command(cid, user_id) -> boolean
--     gtd.enqueue_rf_batch(device_id, lotes, user_id) -> int
--
-- Canales NOTIFY (payload = MAC): gtd_commands, gtd_config -> los escucha el
-- GtD; app_panel_state -> lo escucha la web.

-- ----------------------------------------------------------------------------
-- 14. Roles de conexión — "un solo escritor" impuesto por la BASE
--     La web y el servicio de alarmas comparten SOLO esta base (§8 del diseño);
--     estos GRANTs hacen que la regla no dependa de la disciplina de nadie.
--
--     APLICADO (2026-07-18): el script ejecutable es `roles-conexion-v2.sql`
--     (mismo directorio) — agrega lo que estos comentarios no cubren: USAGE de
--     secuencias para los SERIAL, GRANT del schema y privilegios por defecto
--     para tablas futuras. La app corre como cps_web; las migraciones, con el
--     rol admin (DB_MIGRATIONS_USER en el .env del backend).
-- ----------------------------------------------------------------------------

-- CREATE ROLE cps_web LOGIN PASSWORD '...';
-- CREATE ROLE cps_alarms LOGIN PASSWORD '...';
--
-- -- La web: todo, EXCEPTO escribir estado vivo y tocar la auditoría ajena
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cps_web;
-- REVOKE INSERT, UPDATE, DELETE ON device_state FROM cps_web;
-- REVOKE UPDATE, DELETE ON audit_log FROM cps_web;   -- append-only
-- REVOKE UPDATE, DELETE ON event_response FROM cps_web;
--
-- -- El servicio de alarmas: lee configuración, escribe SOLO por el contrato
-- GRANT SELECT ON ALL TABLES IN SCHEMA public TO cps_alarms;
-- GRANT INSERT ON audit_log TO cps_alarms;
--
-- -- Desde el puente con el GtD (2026-08-03) NO escribe tablas directamente:
-- -- todo pasa por las funciones SECURITY DEFINER del esquema gtd. Eso es lo
-- -- que hace que el contrato lo imponga el motor y no la disciplina.
-- REVOKE INSERT, UPDATE ON device_state FROM cps_alarms;
-- REVOKE INSERT ON event FROM cps_alarms;            -- crea eventos, NO los resuelve
-- GRANT USAGE ON SCHEMA gtd TO cps_alarms, cps_web;
-- REVOKE ALL ON ALL TABLES IN SCHEMA gtd FROM cps_alarms, cps_web;
-- GRANT EXECUTE ON <las 8 de entrada>  TO cps_alarms;
-- GRANT EXECUTE ON <las 4 de salida>   TO cps_web;
