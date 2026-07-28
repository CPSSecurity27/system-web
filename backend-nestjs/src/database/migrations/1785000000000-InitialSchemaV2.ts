import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Esquema inicial v2 — BASE NUEVA. Transcripción fiel de
 * docs/esquema-postgres-v2.sql (raíz del repo), que es la fuente de verdad.
 *
 * Reemplaza a las tres migraciones del modelo v1 (InitialSchema,
 * EmailVerification, UnaccentSearch): se decidió base limpia, sin migración de
 * datos (no había producción).
 *
 * El DDL se escribe a mano (no se genera desde las entidades) porque TypeORM no
 * sabe generar las FK compuestas, los CHECK que dependen de copias de tipo, ni
 * los índices únicos parciales. Esas son las invariantes centrales del dominio:
 * el SQL manda, las entidades lo describen.
 *
 * Qué impone ESTA migración (y no el código):
 *  - una sola cuenta COMPANY (CPS)                      [único parcial]
 *  - exactamente un OWNER por cuenta                    [único parcial]
 *  - un TITULAR por hogar / titular de un solo hogar    [únicos parciales]
 *  - un contrato ACTIVE por barrio                      [único parcial]
 *  - un dispositivo móvil ACTIVE por persona            [único parcial]
 *  - solo ORGANIZATION es dueña de barrios o firma      [FK compuesta + CHECK]
 *  - custodia de inventario coherente (device/remote)   [CHECK]
 *  - staff_assignment no cruza organizaciones           [dos FK compuestas]
 *  - 4 códigos RF por control                           [CHECK + UNIQUE]
 */
export class InitialSchemaV21785000000000 implements MigrationInterface {
  name = 'InitialSchemaV21785000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    // Mantiene updated_at. NO toca updated_by: eso lo setea la aplicación.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    // --- Tipos enumerados (espejo de src/common/enums.ts) -------------------
    await queryRunner.query(
      `CREATE TYPE account_type AS ENUM ('COMPANY', 'ORGANIZATION')`,
    );
    await queryRunner.query(
      `CREATE TYPE org_subtype AS ENUM ('MUNICIPAL', 'PRIVATE')`,
    );
    await queryRunner.query(
      `CREATE TYPE user_role AS ENUM ('OWNER', 'ADMIN', 'TECHNICIAN', 'MONITOR')`,
    );
    await queryRunner.query(
      `CREATE TYPE user_kind AS ENUM ('PERSON', 'INSTITUTIONAL')`,
    );
    await queryRunner.query(
      `CREATE TYPE entity_status AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED')`,
    );
    await queryRunner.query(
      `CREATE TYPE managed_by_type AS ENUM ('CPS', 'ORGANIZATION')`,
    );
    await queryRunner.query(
      `CREATE TYPE home_member_role AS ENUM ('TITULAR', 'FAMILIAR')`,
    );
    await queryRunner.query(
      `CREATE TYPE contract_status AS ENUM ('ACTIVE', 'SUSPENDED', 'EXPIRED', 'CANCELLED')`,
    );
    await queryRunner.query(
      `CREATE TYPE device_type AS ENUM ('ALARM_PANEL', 'SIREN', 'REPEATER', 'SENSOR')`,
    );
    await queryRunner.query(
      `CREATE TYPE device_status AS ENUM ('INVENTORY', 'INSTALLED', 'OPERATIONAL', 'MAINTENANCE', 'OUT_OF_SERVICE', 'RETIRED')`,
    );
    await queryRunner.query(
      `CREATE TYPE maintenance_type AS ENUM ('INSTALL', 'SERVICE', 'REPAIR', 'CHECK', 'REPLACE')`,
    );
    await queryRunner.query(
      `CREATE TYPE maintenance_status AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'CANCELLED')`,
    );
    await queryRunner.query(
      `CREATE TYPE remote_status AS ENUM ('INVENTORY', 'ACTIVE', 'SUSPENDED', 'LOST', 'REPLACED', 'CLOSED')`,
    );
    await queryRunner.query(
      `CREATE TYPE event_origin AS ENUM ('APP', 'REMOTE', 'DEVICE', 'PANEL')`,
    );
    await queryRunner.query(
      `CREATE TYPE event_scope AS ENUM ('SINGLE', 'COMMUNITY')`,
    );
    // ACKNOWLEDGED pospuesto (M5): agregarlo después es ALTER TYPE ... ADD VALUE.
    await queryRunner.query(
      `CREATE TYPE event_status AS ENUM ('OPEN', 'RESOLVED', 'FALSE_ALARM')`,
    );
    await queryRunner.query(
      `CREATE TYPE location_mode AS ENUM ('LIVE', 'FIXED')`,
    );
    await queryRunner.query(
      `CREATE TYPE user_token_type AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET', 'PHONE_OTP')`,
    );
    await queryRunner.query(
      `CREATE TYPE user_device_status AS ENUM ('ACTIVE', 'REVOKED')`,
    );

    // --- Geografía (read-only, sincronizada desde la API de georef) ---------
    // georef_id es TEXT, no INT: los códigos llevan ceros a la izquierda ("06").
    await queryRunner.query(`
      CREATE TABLE province (
        id SERIAL PRIMARY KEY,
        georef_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE department (
        id SERIAL PRIMARY KEY,
        georef_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        province_id INT NOT NULL REFERENCES province(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_department_province ON department(province_id)`,
    );

    await queryRunner.query(`
      CREATE TABLE locality (
        id SERIAL PRIMARY KEY,
        georef_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        department_id INT NOT NULL REFERENCES department(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_locality_department ON locality(department_id)`,
    );

    // Búsqueda insensible a acentos (viene del v1: "cordoba" -> "Córdoba").
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS unaccent`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION immutable_unaccent(text)
        RETURNS text
        LANGUAGE sql
        IMMUTABLE STRICT PARALLEL SAFE
      AS $$ SELECT public.unaccent('public.unaccent', $1) $$
    `);
    await queryRunner.query(`
      CREATE INDEX idx_locality_name_search ON locality
        USING gin (immutable_unaccent(lower(name)) gin_trgm_ops)
    `);

    // --- Personas: app_user -------------------------------------------------
    // ("user" es palabra reservada en PostgreSQL.)
    await queryRunner.query(`
      CREATE TABLE app_user (
        id SERIAL PRIMARY KEY,
        kind user_kind NOT NULL DEFAULT 'PERSON',
        name TEXT NOT NULL,
        username TEXT UNIQUE,
        dni TEXT UNIQUE,
        email TEXT UNIQUE,
        telephone TEXT,
        password_hash TEXT,
        status entity_status NOT NULL DEFAULT 'ACTIVE',
        email_verified_at TIMESTAMPTZ,
        phone_verified_at TIMESTAMPTZ,
        last_login_at TIMESTAMPTZ,
        created_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        updated_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_user_login_identity CHECK (username IS NOT NULL OR dni IS NOT NULL),
        CONSTRAINT chk_institutional_no_dni CHECK (kind <> 'INSTITUTIONAL' OR dni IS NULL)
      )
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_app_user_updated BEFORE UPDATE ON app_user
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN app_user.password_hash IS
        'Hash argon2id. NULL para vecinos que entran solo con DNI + OTP. La base nunca ve la clave en claro.'
    `);

    // --- Cuentas y cupos ----------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE account (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        type account_type NOT NULL,
        subtype org_subtype,
        status entity_status NOT NULL DEFAULT 'ACTIVE',
        max_neighborhoods INT CHECK (max_neighborhoods >= 0),
        max_monitor_users INT CHECK (max_monitor_users >= 0),
        created_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        updated_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_account_id_type UNIQUE (id, type),
        CONSTRAINT chk_subtype_by_type CHECK (
          (type = 'ORGANIZATION' AND subtype IS NOT NULL)
          OR
          (type = 'COMPANY' AND subtype IS NULL
            AND max_neighborhoods IS NULL AND max_monitor_users IS NULL)
        )
      )
    `);
    // CPS es una sola: no puede existir una segunda cuenta COMPANY.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_account_single_company ON account (type)
        WHERE type = 'COMPANY'
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_account_updated BEFORE UPDATE ON account
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN account.max_neighborhoods IS
        'CUPO (tarifa): solo CPS lo escribe, siempre con audit_log. NULL = sin límite.'
    `);

    // --- Membresías del panel ----------------------------------------------
    await queryRunner.query(`
      CREATE TABLE account_user (
        id SERIAL PRIMARY KEY,
        account_id INT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
        user_id INT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
        role user_role NOT NULL,
        created_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_account_user UNIQUE (account_id, user_id),
        CONSTRAINT uq_account_user_id_account UNIQUE (id, account_id)
      )
    `);
    // Exactamente un OWNER por cuenta.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_account_single_owner ON account_user(account_id)
        WHERE role = 'OWNER'
    `);
    await queryRunner.query(
      `CREATE INDEX idx_account_user_user ON account_user(user_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_account_user_account ON account_user(account_id)`,
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_account_user_updated BEFORE UPDATE ON account_user
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);

    // --- Barrio (la unidad operativa) --------------------------------------
    await queryRunner.query(`
      CREATE TABLE neighborhood (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        status entity_status NOT NULL DEFAULT 'ACTIVE',
        locality_id INT NOT NULL REFERENCES locality(id) ON DELETE RESTRICT,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        organization_id INT NOT NULL,
        organization_type account_type NOT NULL DEFAULT 'ORGANIZATION',
        managed_by managed_by_type NOT NULL,
        max_family_members INT NOT NULL DEFAULT 3 CHECK (max_family_members >= 0),
        remote_controls_enabled BOOLEAN NOT NULL DEFAULT true,
        created_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        updated_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_neighborhood_org_type CHECK (organization_type = 'ORGANIZATION'),
        CONSTRAINT fk_neighborhood_org FOREIGN KEY (organization_id, organization_type)
          REFERENCES account(id, type) ON DELETE RESTRICT,
        CONSTRAINT uq_neighborhood_id_org UNIQUE (id, organization_id)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_neighborhood_locality ON neighborhood(locality_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_neighborhood_org ON neighborhood(organization_id)`,
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_neighborhood_updated BEFORE UPDATE ON neighborhood
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN neighborhood.organization_type IS
        'Copia fijada en ORGANIZATION por CHECK y atada con FK compuesta: una COMPANY no puede ser dueña de barrios. No escribir a mano.'
    `);

    // --- Personal acotado por barrio ---------------------------------------
    // Las DOS FK compuestas comparten account_id: asignar un barrio de OTRA
    // organización es imposible a nivel base.
    await queryRunner.query(`
      CREATE TABLE staff_assignment (
        id SERIAL PRIMARY KEY,
        account_user_id INT NOT NULL,
        account_id INT NOT NULL,
        neighborhood_id INT NOT NULL,
        created_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_staff_assignment UNIQUE (account_user_id, neighborhood_id),
        CONSTRAINT fk_sa_membership FOREIGN KEY (account_user_id, account_id)
          REFERENCES account_user(id, account_id) ON DELETE CASCADE,
        CONSTRAINT fk_sa_neighborhood FOREIGN KEY (neighborhood_id, account_id)
          REFERENCES neighborhood(id, organization_id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_sa_neighborhood ON staff_assignment(neighborhood_id)`,
    );

    // --- Contrato (comercial puro, congelado al firmar) ---------------------
    await queryRunner.query(`
      CREATE TABLE service_contract (
        id SERIAL PRIMARY KEY,
        price NUMERIC(12,2) NOT NULL,
        description TEXT,
        start_date DATE NOT NULL,
        end_date DATE,
        status contract_status NOT NULL DEFAULT 'ACTIVE',
        account_id INT NOT NULL,
        account_type account_type NOT NULL DEFAULT 'ORGANIZATION',
        neighborhood_id INT NOT NULL REFERENCES neighborhood(id) ON DELETE RESTRICT,
        created_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        updated_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_contract_org_only CHECK (account_type = 'ORGANIZATION'),
        CONSTRAINT fk_contract_account FOREIGN KEY (account_id, account_type)
          REFERENCES account(id, type) ON DELETE RESTRICT
      )
    `);
    // Un solo contrato ACTIVE por barrio. El 23505 se traduce a 409, no se
    // pre-chequea con SELECT (sería una condición de carrera).
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_contract_active_per_neighborhood
        ON service_contract(neighborhood_id) WHERE status = 'ACTIVE'
    `);
    await queryRunner.query(
      `CREATE INDEX idx_contract_account ON service_contract(account_id)`,
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_contract_updated BEFORE UPDATE ON service_contract
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);

    // --- Activos: device + estado vivo + bitácora ---------------------------
    await queryRunner.query(`
      CREATE TABLE device (
        id SERIAL PRIMARY KEY,
        name TEXT,
        serial TEXT NOT NULL UNIQUE,
        type device_type NOT NULL DEFAULT 'ALARM_PANEL',
        status device_status NOT NULL DEFAULT 'INVENTORY',
        claim_code TEXT,
        manufactured_at TIMESTAMPTZ,
        tested BOOLEAN NOT NULL DEFAULT false,
        imei TEXT,
        iccid TEXT,
        mac TEXT,
        organization_id INT REFERENCES account(id) ON DELETE RESTRICT,
        neighborhood_id INT REFERENCES neighborhood(id) ON DELETE RESTRICT,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        installed_at TIMESTAMPTZ,
        created_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        updated_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_device_custody CHECK (
          (status = 'INVENTORY' AND neighborhood_id IS NULL)
          OR
          (status <> 'INVENTORY' AND neighborhood_id IS NOT NULL)
        ),
        CONSTRAINT chk_device_stock_owner CHECK (
          status = 'INVENTORY' OR organization_id IS NULL
        )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_device_claim_code ON device(claim_code)
        WHERE claim_code IS NOT NULL
    `);
    await queryRunner.query(
      `CREATE INDEX idx_device_neighborhood ON device(neighborhood_id)`,
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_device_updated BEFORE UPDATE ON device
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);

    // Estado VIVO: una fila por device, UPDATE in place, sin historial.
    // La escribe SOLO el servicio de alarmas (GRANTs al final).
    await queryRunner.query(`
      CREATE TABLE device_state (
        device_id INT PRIMARY KEY REFERENCES device(id) ON DELETE CASCADE,
        online BOOLEAN NOT NULL DEFAULT false,
        alarm_status TEXT,
        last_heartbeat TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE device_maintenance (
        id SERIAL PRIMARY KEY,
        device_id INT NOT NULL REFERENCES device(id) ON DELETE CASCADE,
        type maintenance_type NOT NULL,
        status maintenance_status NOT NULL DEFAULT 'PENDING',
        description TEXT,
        performed_at TIMESTAMPTZ,
        user_id INT REFERENCES app_user(id) ON DELETE SET NULL,
        created_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        updated_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_maintenance_device ON device_maintenance(device_id, created_at)`,
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_maintenance_updated BEFORE UPDATE ON device_maintenance
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);

    // --- Hogar y sus miembros -----------------------------------------------
    await queryRunner.query(`
      CREATE TABLE home (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        address TEXT,
        contact_phone TEXT,
        status entity_status NOT NULL DEFAULT 'ACTIVE',
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        neighborhood_id INT NOT NULL REFERENCES neighborhood(id) ON DELETE RESTRICT,
        default_device_id INT REFERENCES device(id) ON DELETE SET NULL,
        created_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        updated_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_home_neighborhood ON home(neighborhood_id)`,
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_home_updated BEFORE UPDATE ON home
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN home.default_device_id IS
        'Alarma PREFERIDA para eventos SINGLE. Preferencia, no propiedad: debe ser del mismo barrio (regla de servicio). NULL = el sistema elige.'
    `);

    await queryRunner.query(`
      CREATE TABLE home_member (
        id SERIAL PRIMARY KEY,
        home_id INT NOT NULL REFERENCES home(id) ON DELETE CASCADE,
        user_id INT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
        role home_member_role NOT NULL,
        status entity_status NOT NULL DEFAULT 'ACTIVE',
        created_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_home_member UNIQUE (home_id, user_id)
      )
    `);
    // Un solo TITULAR por hogar…
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_home_single_titular ON home_member(home_id)
        WHERE role = 'TITULAR'
    `);
    // …y una persona es titular de UN solo hogar (regla del PDF que se conserva).
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_user_single_titular ON home_member(user_id)
        WHERE role = 'TITULAR'
    `);
    await queryRunner.query(
      `CREATE INDEX idx_home_member_user ON home_member(user_id)`,
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_home_member_updated BEFORE UPDATE ON home_member
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);

    // --- Controles remotos y códigos RF -------------------------------------
    await queryRunner.query(`
      CREATE TABLE remote (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        status remote_status NOT NULL DEFAULT 'INVENTORY',
        organization_id INT REFERENCES account(id) ON DELETE RESTRICT,
        home_id INT REFERENCES home(id) ON DELETE RESTRICT,
        assigned_to_user_id INT REFERENCES app_user(id) ON DELETE SET NULL,
        device_id INT REFERENCES device(id) ON DELETE SET NULL,
        created_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        updated_by INT REFERENCES app_user(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_remote_custody CHECK (
          (status = 'INVENTORY' AND home_id IS NULL)
          OR
          (status <> 'INVENTORY' AND home_id IS NOT NULL)
        ),
        CONSTRAINT chk_remote_stock_owner CHECK (
          status = 'INVENTORY' OR organization_id IS NULL
        )
      )
    `);
    await queryRunner.query(`CREATE INDEX idx_remote_home ON remote(home_id)`);
    await queryRunner.query(
      `CREATE INDEX idx_remote_assigned ON remote(assigned_to_user_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_remote_device ON remote(device_id)`,
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_remote_updated BEFORE UPDATE ON remote
        FOR EACH ROW EXECUTE FUNCTION set_updated_at()
    `);

    await queryRunner.query(`
      CREATE TABLE remote_code (
        id SERIAL PRIMARY KEY,
        remote_id INT NOT NULL REFERENCES remote(id) ON DELETE CASCADE,
        code_encrypted BYTEA NOT NULL,
        position SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 4),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_remote_code_position UNIQUE (remote_id, position)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_remote_code_remote ON remote_code(remote_id)`,
    );
    await queryRunner.query(`
      COMMENT ON TABLE remote_code IS
        'SENSIBLE. Códigos RF que ABREN LA ALARMA, cifrados AES-256-GCM en NestJS antes de insertar (iv || authTag || ciphertext). 4 códigos por control (M2).'
    `);

    // --- Eventos (append-only, ILIMITADOS) ----------------------------------
    await queryRunner.query(`
      CREATE TABLE event (
        id BIGSERIAL PRIMARY KEY,
        neighborhood_id INT NOT NULL REFERENCES neighborhood(id) ON DELETE RESTRICT,
        device_id INT REFERENCES device(id) ON DELETE RESTRICT,
        home_id INT REFERENCES home(id) ON DELETE RESTRICT,
        remote_id INT REFERENCES remote(id) ON DELETE RESTRICT,
        origin event_origin NOT NULL,
        scope event_scope NOT NULL DEFAULT 'SINGLE',
        trigger_mode TEXT,
        gps_lat DOUBLE PRECISION,
        gps_lng DOUBLE PRECISION,
        location_mode location_mode,
        activator_user_id INT REFERENCES app_user(id) ON DELETE SET NULL,
        activator_name TEXT,
        activator_phone TEXT,
        status event_status NOT NULL DEFAULT 'OPEN',
        resolved_by_user_id INT REFERENCES app_user(id) ON DELETE SET NULL,
        resolver_name TEXT,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_event_neighborhood ON event(neighborhood_id, created_at DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_event_open ON event(neighborhood_id) WHERE status = 'OPEN'`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_event_device ON event(device_id)`,
    );
    await queryRunner.query(`
      COMMENT ON COLUMN event.activator_name IS
        'SNAPSHOT congelado al momento del evento (criterio factura): si el vecino cambia de teléfono, el evento histórico no cambia.'
    `);

    await queryRunner.query(`
      CREATE TABLE event_response (
        id BIGSERIAL PRIMARY KEY,
        event_id BIGINT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
        user_id INT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_event_response UNIQUE (event_id, user_id)
      )
    `);

    // --- Sesiones, tokens, dispositivos de app, auditoría -------------------
    await queryRunner.query(`
      CREATE TABLE refresh_token (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        user_agent TEXT,
        ip_address INET,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_refresh_token_user ON refresh_token(user_id)`,
    );
    await queryRunner.query(`
      CREATE INDEX idx_refresh_token_active ON refresh_token(user_id)
        WHERE revoked_at IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE user_token (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
        type user_token_type NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_user_token_user ON user_token(user_id, type)`,
    );
    await queryRunner.query(`
      CREATE INDEX idx_user_token_pending ON user_token(user_id, type)
        WHERE used_at IS NULL
    `);

    // Un celular ACTIVO por persona: registrar uno nuevo revoca el anterior.
    await queryRunner.query(`
      CREATE TABLE user_device (
        id SERIAL PRIMARY KEY,
        user_id INT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
        platform TEXT,
        device_fingerprint TEXT,
        fcm_token TEXT,
        status user_device_status NOT NULL DEFAULT 'ACTIVE',
        last_seen_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_user_device_user ON user_device(user_id)`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_user_device_active ON user_device(user_id)
        WHERE status = 'ACTIVE'
    `);

    // Append-only: sin UPDATE ni DELETE (se refuerza con GRANTs cuando se creen
    // los roles de conexión — ver docs/esquema-postgres-v2.sql §13).
    await queryRunner.query(`
      CREATE TABLE audit_log (
        id BIGSERIAL PRIMARY KEY,
        actor_user_id INT REFERENCES app_user(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id BIGINT,
        account_id INT,
        neighborhood_id INT,
        old_value JSONB,
        new_value JSONB,
        metadata JSONB,
        ip_address TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_audit_actor ON audit_log(actor_user_id, created_at DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'audit_log',
      'user_device',
      'user_token',
      'refresh_token',
      'event_response',
      'event',
      'remote_code',
      'remote',
      'home_member',
      'home',
      'device_maintenance',
      'device_state',
      'device',
      'service_contract',
      'staff_assignment',
      'neighborhood',
      'account_user',
      'account',
      'app_user',
      'locality',
      'department',
      'province',
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }

    await queryRunner.query(`DROP INDEX IF EXISTS idx_locality_name_search`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS immutable_unaccent(text)`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS set_updated_at()`);

    for (const type of [
      'user_device_status',
      'user_token_type',
      'location_mode',
      'event_status',
      'event_scope',
      'event_origin',
      'remote_status',
      'maintenance_status',
      'maintenance_type',
      'device_status',
      'device_type',
      'contract_status',
      'home_member_role',
      'managed_by_type',
      'entity_status',
      'user_kind',
      'user_role',
      'org_subtype',
      'account_type',
    ]) {
      await queryRunner.query(`DROP TYPE IF EXISTS ${type}`);
    }
  }
}
