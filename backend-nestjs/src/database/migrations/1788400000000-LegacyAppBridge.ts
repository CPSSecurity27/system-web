import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Puente con la app vieja de vecinos (2026-08-07).
 *
 * Hay clientes que no van a actualizar la app. La que tienen instalada
 * (`com.cpssecurity.app_alarma` v4.0.0+4) habla con el sistema VIEJO y no se
 * puede tocar: es un APK ya distribuido. Sus cuatro superficies son fijas.
 *
 * De esas cuatro, esta migración habilita la de SUBIDA: la app publica en el
 * tópico MQTT `cliente/servidor` un `{cliente_id, modo_a, gps}` y espera que
 * suene la alarma. Hasta hoy eso lo traducía `broker-bridge.service`, que
 * escribía en Firebase; el proceso que lo reemplaza escribe acá.
 *
 * Tres piezas:
 *
 * 1. `device.legacy_marker` — el alias por el que la app vieja conoce a cada
 *    alarma (`CENTRALVECINAL05`). Es de la ALARMA, no del hogar: en Firebase
 *    colgaba del cliente (`ClientesID/<DNI>/Marcador`) y copiarlo así habría
 *    violado la regla 1 del dominio. El hogar llega a su marcador por
 *    `default_device_id`, derivándolo, sin guardar una segunda copia.
 *
 *    Además define QUIÉN es legacy: un hogar es alcanzable desde la app vieja
 *    si —y solo si— su alarma preferida tiene marcador. Sin listas congeladas.
 *
 * 2. `gtd.legacy_mode_map` — la traducción `cps00X` ⇄ slug del firmware. Es
 *    TABLA y no un CASE adentro de una función por dos razones: cambiar a qué
 *    dispara "Policía" es un UPDATE y no una migración, y la vuelta
 *    (slug → etiqueta en castellano) la necesita la proyección a Firebase para
 *    reconstruir la tarjeta que la app muestra. El UNIQUE sobre `trigger_mode`
 *    es lo que garantiza que esa vuelta esté bien definida.
 *
 * 3. `gtd.legacy_activation` — el DNI y el GPS que mandó la app, guardados
 *    contra el `cid` del comando.
 *
 * ── Por qué el `cid` y no otra cosa ──
 *
 * El problema es de correlación: el que sabe QUIÉN activó es el adaptador, en
 * el momento en que recibe el MQTT; el que crea el `event` es el panel, varios
 * segundos después, cuando reporta `up t:alarma`. Y el firmware NO reenvía el
 * DNI: solo lo manda cuando `origin='rf'` (lo dice el contrato MQTT, §up). Con
 * `origin='mqtt'` lo único que vuelve es el `cid` del comando.
 *
 * Ese `cid` ya viaja entero hasta `insert_evento`: el GtD le pasa el documento
 * completo del mensaje (`pipeline/uplink.py`), y la función ya lee
 * `p_payload->>'origin'`, `->>'mode'` y `->>'dni'` de ahí. O sea que
 * `p_payload->>'cid'` estaba disponible sin cambiarle la firma a nada y sin
 * tocar una línea del GtD.
 *
 * Por eso el activador se resuelve DENTRO de `insert_evento` y no con un UPDATE
 * posterior: `event` es append-only a propósito (no tiene `updated_at`; la web
 * solo toca `status`/`resolved_*` al resolver). Completarlo en una segunda
 * pasada pelearía contra el diseño y abriría una ventana en la que el monitoreo
 * ve una emergencia sin dueño. Adentro de la función nace completo, en la misma
 * transacción, o no nace.
 *
 * ── La advertencia que va con esto ──
 *
 * El listener 1883 es anónimo (`deploy/legacy-1883.acl`: `topic readwrite #`) y
 * la app vieja no tiene autenticación — su login es "existe este DNI". O sea
 * que cualquiera puede publicar una activación a nombre de cualquier DNI. Eso
 * ya era verdad con el bridge; lo que cambia es que a partir de acá el sistema
 * pasa de decir "sonó una alarma" a AFIRMAR "la disparó Fulano, tel tal, desde
 * estas coordenadas" — algo que no puede verificar.
 *
 * De ahí que `enqueue_legacy_alarm` sea estricta y no acepte un destino: el DNI
 * tiene que existir, estar ACTIVE, tener un `home_member` ACTIVE, y la alarma
 * es SIEMPRE la preferida de ese hogar y encima tiene que tener `legacy_marker`.
 * La puerta vieja no llega a ningún equipo que no esté explícitamente marcado
 * como servido por ella.
 *
 * La fila de `legacy_activation` queda como rastro de que esa identidad entró
 * por la puerta vieja, que es también el motivo de no ensuciar el enum
 * `event_origin` con un valor temporal: el JOIN lo dice.
 */
export class LegacyAppBridge1788400000000 implements MigrationInterface {
  name = 'LegacyAppBridge1788400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ------------------------------------------------------------------
    // 1. device.legacy_marker
    // ------------------------------------------------------------------
    await queryRunner.query(`ALTER TABLE device ADD COLUMN legacy_marker TEXT`);

    // El formato no es decorativo: este string se usa como RAÍZ de un path de
    // Firebase RTDB y como TÓPICO de FCM. Un valor con '.', '#', '$', '[' o '/'
    // rompe el primero, y uno con caracteres fuera de [A-Za-z0-9-_.~%] rompe el
    // segundo. El CHECK evita que un typo en el panel se descubra recién cuando
    // no le llega el aviso a un barrio.
    await queryRunner.query(`
      ALTER TABLE device
        ADD CONSTRAINT chk_device_legacy_marker
          CHECK (legacy_marker IS NULL OR legacy_marker ~ '^CENTRALVECINAL[0-9]{2}$')
    `);
    // Índice parcial y no UNIQUE de tabla: es el estilo que ya usan
    // uq_device_claim_code y uq_device_mac para los únicos nulables de device.
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_device_legacy_marker
        ON device(legacy_marker) WHERE legacy_marker IS NOT NULL
    `);

    await queryRunner.query(`
      COMMENT ON COLUMN device.legacy_marker IS
        'Alias por el que la app VIEJA conoce a esta alarma (CENTRALVECINAL05). Raíz del path en la RTDB y tópico FCM. NULL = la app vieja no la alcanza. Temporal: se va con la app vieja.'
    `);

    // Backfill por SERIAL, no por id: el serial es la identidad física del
    // equipo y no depende del orden en que se cargó la base. En una base nueva
    // no matchea nada y la migración sigue siendo válida.
    //
    // El mapeo sale de la migración de datos del 2026-08-06 (Firebase →
    // Postgres), donde cada hogar quedó apuntando a su alarma por el Marcador
    // que tenía en `ClientesID`.
    await queryRunner.query(`
      UPDATE device SET legacy_marker = 'CENTRALVECINAL05'
       WHERE serial = 'AV-A842E38FCA6C' AND legacy_marker IS NULL
    `);
    await queryRunner.query(`
      UPDATE device SET legacy_marker = 'CENTRALVECINAL06'
       WHERE serial = 'AV-A842E38FCA24' AND legacy_marker IS NULL
    `);

    // ------------------------------------------------------------------
    // 2. gtd.legacy_mode_map
    // ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE gtd.legacy_mode_map (
        legacy_code  TEXT PRIMARY KEY,
        trigger_mode TEXT NOT NULL,
        label        TEXT NOT NULL,

        CONSTRAINT chk_legacy_trigger_mode CHECK (trigger_mode IN (
          'off', 'suspicious', 'alert', 'emergency',
          'fire', 'medical', 'silent', 'panic'
        )),
        -- La proyección a Firebase necesita la vuelta (slug -> etiqueta). Sin
        -- este UNIQUE esa vuelta sería ambigua y la tarjeta de la app vieja
        -- mostraría cualquiera de los dos motivos.
        CONSTRAINT uq_legacy_trigger_mode UNIQUE (trigger_mode)
      )
    `);

    await queryRunner.query(`
      COMMENT ON TABLE gtd.legacy_mode_map IS
        'Traducción cps00X (app vieja / Firebase) <-> slug del firmware. Biyectiva. Es tabla y no un CASE para poder corregir un mapeo sin migración.'
    `);

    // Los `label` son lo que la app VIEJA muestra: la lee de
    // `<Marcador>/Instrucciones/InstruccionesActivacion/modoalarma` y la
    // imprime VERBATIM, sin traducir nada (`Text(activation.modoalarma)` en
    // main.dart). O sea que lo que se escriba acá es literalmente lo que ve el
    // vecino en el teléfono.
    //
    // Se usan las etiquetas del catálogo NUEVO (las mismas de
    // `frontend-angular/src/app/core/alarm-modes.ts`) y no las de MODO_MAP del
    // broker-bridge, por dos razones que salieron de mirar la base real el
    // 2026-08-07:
    //
    // 1. **No hay consistencia que preservar.** En producción conviven los dos
    //    formatos: las activaciones que entraron por el control RF quedaron con
    //    el código crudo ('cps001', 'cps999' — el bridge reenvía AlarmaRF.MODO
    //    sin traducir) y las que entraron por la app, con la etiqueta
    //    ('SOSPECHOSO'). Hoy el vecino ve "cps001" la mitad de las veces.
    // 2. Ahora TODAS las activaciones pasan por esta proyección, sin importar
    //    el origen. Usar el catálogo nuevo hace que el mismo evento se lea
    //    igual en el panel de monitoreo y en el teléfono del vecino.
    //
    // Y por lo mismo se corrigen los typos de MODO_MAP ("SILECIOSA",
    // "INCEDIO"): copiarlos era defendible mientras la idea fuera calcar el
    // historial existente, y ese historial resultó ser un mezcla.
    await queryRunner.query(`
      INSERT INTO gtd.legacy_mode_map (legacy_code, trigger_mode, label) VALUES
        ('cps001', 'emergency',  'Activar alarma'),
        ('cps002', 'suspicious', 'Sospechoso'),
        ('cps003', 'alert',      'Ladrón'),
        ('cps004', 'panic',      'Policía'),
        ('cps005', 'silent',     'Silenciosa'),
        ('cps006', 'fire',       'Incendio'),
        ('cps007', 'medical',    'Médica'),
        ('cps999', 'off',        'Desactivar')
    `);

    // ------------------------------------------------------------------
    // 3. gtd.legacy_activation
    // ------------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE gtd.legacy_activation (
        cid          TEXT PRIMARY KEY,
        -- El DNI tal como lo mandó la app: es lo AFIRMADO. user_id es a quién
        -- resolvimos. Guardar los dos permite ver después que alguien publicó
        -- un DNI que no era suyo.
        dni          TEXT NOT NULL,
        user_id      INT REFERENCES app_user(id) ON DELETE SET NULL,
        home_id      INT REFERENCES home(id)     ON DELETE SET NULL,
        device_id    INT NOT NULL REFERENCES device(id) ON DELETE CASCADE,
        legacy_code  TEXT NOT NULL,
        trigger_mode TEXT NOT NULL,
        gps_lat      DOUBLE PRECISION,
        gps_lng      DOUBLE PRECISION,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      COMMENT ON TABLE gtd.legacy_activation IS
        'Lo que mandó la app vieja por cliente/servidor, atado al cid del comando. insert_evento lo lee para poner activador y GPS en el event. Temporal: se va con la app vieja.'
    `);

    await queryRunner.query(`
      CREATE INDEX ix_legacy_activation_created
        ON gtd.legacy_activation(created_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX ix_legacy_activation_device
        ON gtd.legacy_activation(device_id, created_at DESC)
    `);

    // ------------------------------------------------------------------
    // 4. enqueue_legacy_alarm — la única puerta del adaptador
    // ------------------------------------------------------------------
    // El adaptador queda TONTO a propósito: parsea el JSON del MQTT y llama a
    // esto. No elige equipo, no valida cupos, no escribe SQL. Toda la decisión
    // vive acá, en un solo lugar, adentro de una transacción.
    await queryRunner.query(`
      CREATE FUNCTION gtd.enqueue_legacy_alarm(
        p_dni  TEXT,
        p_code TEXT,
        p_lat  DOUBLE PRECISION DEFAULT NULL,
        p_lng  DOUBLE PRECISION DEFAULT NULL
      ) RETURNS TABLE (cid TEXT, resultado TEXT)
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_user     app_user%ROWTYPE;
        v_home     home%ROWTYPE;
        v_device   device%ROWTYPE;
        v_member   home_member%ROWTYPE;
        v_mode     TEXT;
        v_cid      TEXT;
        v_dni      TEXT := NULLIF(TRIM(COALESCE(p_dni, '')), '');
      BEGIN
        SELECT m.trigger_mode INTO v_mode
          FROM gtd.legacy_mode_map m WHERE m.legacy_code = p_code;
        IF v_mode IS NULL THEN
          RETURN QUERY SELECT NULL::TEXT, 'modo_invalido'; RETURN;
        END IF;

        -- La app se autolimita a IDs de más de 4 dígitos; no le creemos nada.
        IF v_dni IS NULL OR v_dni !~ '^[0-9]{5,}$' THEN
          RETURN QUERY SELECT NULL::TEXT, 'dni_invalido'; RETURN;
        END IF;

        SELECT * INTO v_user FROM app_user u WHERE u.dni = v_dni;
        IF v_user.id IS NULL THEN
          RETURN QUERY SELECT NULL::TEXT, 'dni_desconocido'; RETURN;
        END IF;
        IF v_user.status <> 'ACTIVE' THEN
          RETURN QUERY SELECT NULL::TEXT, 'usuario_no_activo'; RETURN;
        END IF;

        -- uq_home_member_one_home garantiza a lo sumo una fila, activa o no.
        -- Se busca sin filtrar por estado para poder distinguir "no tiene
        -- hogar" de "lo dieron de baja", que operativamente no son lo mismo.
        SELECT * INTO v_member FROM home_member hm WHERE hm.user_id = v_user.id;
        IF v_member.id IS NULL THEN
          RETURN QUERY SELECT NULL::TEXT, 'sin_hogar'; RETURN;
        END IF;
        IF v_member.status <> 'ACTIVE' THEN
          RETURN QUERY SELECT NULL::TEXT, 'membresia_no_activa'; RETURN;
        END IF;

        SELECT * INTO v_home FROM home h WHERE h.id = v_member.home_id;
        IF v_home.status <> 'ACTIVE' THEN
          RETURN QUERY SELECT NULL::TEXT, 'hogar_no_activo'; RETURN;
        END IF;

        -- El destino NO viene del mensaje: es siempre la alarma preferida del
        -- hogar. Un mensaje anónimo no elige a qué equipo le pega.
        IF v_home.default_device_id IS NULL THEN
          RETURN QUERY SELECT NULL::TEXT, 'hogar_sin_alarma'; RETURN;
        END IF;
        SELECT * INTO v_device FROM device d WHERE d.id = v_home.default_device_id;
        IF v_device.legacy_marker IS NULL THEN
          RETURN QUERY SELECT NULL::TEXT, 'alarma_no_legacy'; RETURN;
        END IF;

        v_cid := gtd.enqueue_command(
          v_device.id, 'alarma', jsonb_build_object('mode', v_mode), v_user.id
        );

        INSERT INTO gtd.legacy_activation (
          cid, dni, user_id, home_id, device_id, legacy_code, trigger_mode,
          gps_lat, gps_lng
        ) VALUES (
          v_cid, v_dni, v_user.id, v_home.id, v_device.id, p_code, v_mode,
          p_lat, p_lng
        );

        -- El actor es el vecino que la app DICE que es. La acción lleva el
        -- prefijo legacy. justamente para que al leer la auditoría se sepa
        -- que esa identidad entró por una puerta sin autenticación.
        INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, new_value)
        VALUES (v_user.id, 'legacy.alarm.activate', 'device', v_device.id,
                jsonb_build_object('cid', v_cid, 'dni', v_dni, 'code', p_code,
                                   'mode', v_mode, 'lat', p_lat, 'lng', p_lng));

        RETURN QUERY SELECT v_cid, 'ok';
      END;
      $fn$
    `);

    // ------------------------------------------------------------------
    // 5. close_legacy_events — el botón "Desactivar" de la app vieja
    // ------------------------------------------------------------------
    // El cps999 apaga la sirena (sale como cmd t:alarma mode:off) pero un
    // mode:off NO crea evento: cae en el dead letter como 'desarme'. Sin esto,
    // las emergencias abiertas por la app vieja quedaban OPEN para siempre y el
    // tablero de monitoreo se llenaba de fantasmas — el vecino con la app vieja
    // no tiene panel web, ese botón es su ÚNICO cierre.
    //
    // CIERRA CUALQUIER EVENTO ABIERTO DEL EQUIPO, sin exigir que lo cierre quien
    // lo abrió. Es una decisión de negocio tomada a conciencia (2026-08-07): en
    // una alarma de barrio el que la apaga casi nunca es el que la disparó, y
    // atarlo al DNI dejaría alarmas sonando. Queda registrado QUIÉN la cerró.
    //
    // ── Excepción explícita a "el servicio de alarmas no resuelve eventos" ──
    // Esa regla (docs/roles-conexion-v2.sql) sigue en pie donde importa: el rol
    // cps_alarms NO gana UPDATE sobre `event`. El cierre pasa por una función
    // SECURITY DEFINER acotada —solo con desarme, solo con un cid que tenga
    // fila legacy, solo sobre ese equipo— y deja audit_log. Mismo mecanismo por
    // el que confirm_provisioning escribe `device` sin que el provisioner pueda.
    //
    // SOLO aplica a la puerta vieja. Un mode:off del panel web o del botón D de
    // un control remoto sigue sin cerrar nada, igual que antes: cambiar eso
    // sería reescribir en silencio el comportamiento de los otros dos orígenes.
    await queryRunner.query(`
      CREATE FUNCTION gtd.close_legacy_events(p_device_id INT, p_cid TEXT)
      RETURNS INT
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_legacy gtd.legacy_activation%ROWTYPE;
        v_user   app_user%ROWTYPE;
        v_n      INT;
      BEGIN
        SELECT * INTO v_legacy FROM gtd.legacy_activation la WHERE la.cid = p_cid;
        -- El desarme no vino de la app vieja: no es asunto de esta función.
        IF v_legacy.cid IS NULL THEN
          RETURN 0;
        END IF;

        SELECT * INTO v_user FROM app_user WHERE id = v_legacy.user_id;

        UPDATE event
           SET status              = 'RESOLVED',
               resolved_by_user_id = v_user.id,
               resolver_name       = v_user.name,
               resolved_at         = now()
         WHERE device_id = p_device_id AND status = 'OPEN';
        GET DIAGNOSTICS v_n = ROW_COUNT;

        IF v_n > 0 THEN
          INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, new_value)
          VALUES (v_user.id, 'legacy.event.resolve', 'device', p_device_id,
                  jsonb_build_object('cid', p_cid, 'dni', v_legacy.dni,
                                     'cerrados', v_n));
        END IF;

        RETURN v_n;
      END;
      $fn$
    `);

    // ------------------------------------------------------------------
    // 6. insert_evento — ahora resuelve también el activador de la puerta vieja
    // ------------------------------------------------------------------
    // Cambia SOLO el bloque del activador y la lista de columnas del INSERT
    // (gps_lat/gps_lng/location_mode). El resto es idéntico a
    // GtdBridgeFunctions: el dead letter, el mapeo de origen y el dedup por eid
    // no se tocan, y el contrato con el GtD (firma y booleano) tampoco.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION gtd.insert_evento(
        p_mac     TEXT,
        p_tipo    TEXT,
        p_payload JSONB,
        p_eid     TEXT   DEFAULT NULL,
        p_ts      BIGINT DEFAULT NULL
      ) RETURNS BOOLEAN
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_device        device%ROWTYPE;
        v_ts            TIMESTAMPTZ := CASE WHEN p_ts IS NULL
                                            THEN NULL ELSE to_timestamp(p_ts) END;
        v_tsq           SMALLINT    := (p_payload->>'tsq')::SMALLINT;
        v_mode          TEXT        := p_payload->>'mode';
        v_dni           TEXT        := NULLIF(p_payload->>'dni', '0');
        v_cid           TEXT        := p_payload->>'cid';
        v_origin        event_origin;
        v_user          app_user%ROWTYPE;
        v_home_id       INT;
        v_remote_id     INT;
        v_event_id      BIGINT;
        v_resultado     TEXT;
        v_legacy        gtd.legacy_activation%ROWTYPE;
        v_gps_lat       DOUBLE PRECISION;
        v_gps_lng       DOUBLE PRECISION;
        v_loc_mode      location_mode;
      BEGIN
        SELECT * INTO v_device FROM device WHERE mac = p_mac;

        -- Todo lo que no es una alarma con destino termina en el dead letter.
        -- Nada se descarta: event.neighborhood_id es NOT NULL, así que sin esto
        -- una alarma de un equipo sin barrio se perdería para siempre.
        v_resultado := CASE
          WHEN v_device.id IS NULL              THEN 'unknown_device'
          WHEN p_tipo <> 'alarma'               THEN 'sin_destino'
          WHEN v_mode = 'off'                   THEN 'desarme'
          WHEN v_device.neighborhood_id IS NULL THEN 'orphan'
          ELSE NULL
        END;

        IF v_resultado IS NOT NULL THEN
          INSERT INTO gtd.uplink_raw (mac, tipo, eid, payload, ts_device, tsq, resultado)
          VALUES (p_mac, p_tipo, p_eid, p_payload, v_ts, v_tsq, v_resultado);

          -- El cps999 de la app vieja. Se cierra ACÁ y no al encolar el
          -- comando: si el panel está caído y nunca lo recibe, cerrar el evento
          -- dejaría al tablero diciendo "resuelto" con la sirena sonando. El
          -- desarme se refleja cuando el equipo REPORTA que se apagó.
          IF v_resultado = 'desarme' AND v_cid IS NOT NULL THEN
            PERFORM gtd.close_legacy_events(v_device.id, v_cid);
          END IF;

          -- TRUE porque no es un duplicado: el GtD no debe reintentar.
          RETURN true;
        END IF;

        v_origin := CASE p_payload->>'origin'
          WHEN 'rf'     THEN 'REMOTE'   -- control remoto del hogar
          WHEN 'mqtt'   THEN 'APP'      -- disparo por comando del servidor
          WHEN 'auto'   THEN 'DEVICE'   -- el propio equipo
          WHEN 'portal' THEN 'PANEL'    -- portal cautivo local (rol tec/cps)
          ELSE 'DEVICE'
        END::event_origin;

        -- El dni que vuelve es el que NOSOTROS cargamos en la base RF del panel
        -- (cmd t:rf op:batch). El panel no dispara con un código que no tiene,
        -- así que un dni desconocido acá es una inconsistencia nuestra, no del
        -- equipo: se registra el evento igual, sin activador.
        IF v_dni IS NOT NULL THEN
          SELECT * INTO v_user FROM app_user WHERE dni = v_dni;
          SELECT home_id INTO v_home_id
            FROM home_member WHERE user_id = v_user.id AND status = 'ACTIVE';
          SELECT id INTO v_remote_id
            FROM remote
           WHERE assigned_to_user_id = v_user.id AND device_id = v_device.id
           LIMIT 1;
        END IF;

        -- La puerta vieja. El firmware solo manda dni cuando origin='rf', así
        -- que una activación de la app legacy llega acá ANÓNIMA: lo único que
        -- vuelve es el cid del comando que la originó. Ese cid es el hilo que
        -- ata la persona con el evento, y del otro lado lo dejó
        -- enqueue_legacy_alarm.
        IF v_user.id IS NULL AND v_cid IS NOT NULL THEN
          SELECT * INTO v_legacy FROM gtd.legacy_activation la WHERE la.cid = v_cid;
          IF v_legacy.cid IS NOT NULL THEN
            SELECT * INTO v_user FROM app_user WHERE id = v_legacy.user_id;
            v_home_id := v_legacy.home_id;
            v_gps_lat := v_legacy.gps_lat;
            v_gps_lng := v_legacy.gps_lng;
            -- La app vieja manda un fix puntual del momento de apretar, no un
            -- seguimiento: es FIXED. live no existe de este lado.
            IF v_gps_lat IS NOT NULL AND v_gps_lng IS NOT NULL THEN
              v_loc_mode := 'FIXED'::location_mode;
            END IF;
          END IF;
        END IF;

        INSERT INTO event (
          neighborhood_id, device_id, home_id, remote_id,
          origin, trigger_mode, external_id, ts_device, tsq,
          gps_lat, gps_lng, location_mode,
          activator_user_id, activator_name, activator_phone
        ) VALUES (
          v_device.neighborhood_id, v_device.id, v_home_id, v_remote_id,
          v_origin, v_mode, p_eid, v_ts, v_tsq,
          v_gps_lat, v_gps_lng, v_loc_mode,
          v_user.id, v_user.name, v_user.telephone
        )
        ON CONFLICT (device_id, external_id) WHERE external_id IS NOT NULL
        DO NOTHING
        RETURNING id INTO v_event_id;

        RETURN v_event_id IS NOT NULL;
      END;
      $fn$
    `);

    // ------------------------------------------------------------------
    // 7. La BAJADA: qué ve la app vieja
    // ------------------------------------------------------------------
    // La app lee tres cosas de la RTDB y las muestra CRUDAS. El proyector las
    // escribe desde Postgres; estas funciones son su única lectura, para que el
    // rol `cps_legacy` no necesite SELECT sobre event, home, app_user y
    // device_state — o sea, sobre medio esquema.
    //
    // OJO con `estado`: la app hace `if (estado == 'Activada')` para decidir si
    // muestra la tarjeta de quién activó. Si este string no dice exactamente
    // eso, los datos se escriben bien y el vecino no ve nada. El vocabulario es
    // cerrado y sale de main.dart: 'Conectada' | 'Activada' | otra cosa = gris.
    //
    // Una emergencia abierta gana sobre el equipo caído: si hay algo pasando,
    // el vecino tiene que verlo aunque el panel haya perdido el enlace.
    await queryRunner.query(`
      CREATE FUNCTION gtd.legacy_snapshot(p_device_id INT)
      RETURNS TABLE (
        marcador   TEXT,
        estado     TEXT,
        event_id   BIGINT,
        usuario    TEXT,
        telefono   TEXT,
        direccion  TEXT,
        modoalarma TEXT,
        gps_lat    DOUBLE PRECISION,
        gps_lng    DOUBLE PRECISION,
        creado     TIMESTAMPTZ
      )
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_device device%ROWTYPE;
        v_online BOOLEAN;
        v_ev     event%ROWTYPE;
      BEGIN
        SELECT * INTO v_device FROM device d WHERE d.id = p_device_id;
        IF v_device.legacy_marker IS NULL THEN
          RETURN;   -- no es una alarma de la puerta vieja: nada que proyectar
        END IF;

        SELECT ds.online INTO v_online
          FROM device_state ds WHERE ds.device_id = p_device_id;

        SELECT * INTO v_ev
          FROM event e
         WHERE e.device_id = p_device_id AND e.status = 'OPEN'
         ORDER BY e.created_at DESC
         LIMIT 1;

        RETURN QUERY
        SELECT
          v_device.legacy_marker,
          CASE
            WHEN v_ev.id IS NOT NULL       THEN 'Activada'
            WHEN COALESCE(v_online, false) THEN 'Conectada'
            ELSE 'Desconectada'
          END,
          v_ev.id,
          v_ev.activator_name,
          v_ev.activator_phone,
          (SELECT h.address FROM home h WHERE h.id = v_ev.home_id),
          COALESCE(
            (SELECT m.label FROM gtd.legacy_mode_map m
              WHERE m.trigger_mode = v_ev.trigger_mode),
            v_ev.trigger_mode
          ),
          v_ev.gps_lat,
          v_ev.gps_lng,
          v_ev.created_at;
      END;
      $fn$
    `);

    // El barrido inicial y la reconciliación: sin esto, un proyector que estuvo
    // caído no sabe qué se perdió. Mismo criterio que el barrido del GtD.
    await queryRunner.query(`
      CREATE FUNCTION gtd.legacy_devices()
      RETURNS TABLE (device_id INT, marcador TEXT)
      LANGUAGE sql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
        SELECT d.id, d.legacy_marker FROM device d
         WHERE d.legacy_marker IS NOT NULL
         ORDER BY d.legacy_marker;
      $fn$
    `);

    // El catálogo que la app vieja usa para el login y para "Mi familia".
    // Un vecino es legacy si su hogar apunta a una alarma con marcador; la
    // lista sale de los datos, no de una lista congelada que alguien mantiene.
    //
    // `familia` son los OTROS miembros del hogar: la app arma la lista de la
    // familia con las claves `usuarioN` y el cupo con `nuser`.
    await queryRunner.query(`
      CREATE FUNCTION gtd.legacy_clientes()
      RETURNS TABLE (
        dni       TEXT,
        usuario   TEXT,
        telefono  TEXT,
        direccion TEXT,
        marcador  TEXT,
        suspension TEXT,
        cupo      INT,
        familia   TEXT[]
      )
      LANGUAGE sql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
        SELECT
          u.dni,
          u.name,
          u.telephone,
          h.address,
          d.legacy_marker,
          -- La app corta el envío si Suspension = 'ON' (lo hacía el bridge).
          -- Un hogar suspendido suspende a todos sus miembros.
          CASE WHEN u.status = 'ACTIVE'
                AND h.status = 'ACTIVE'
                AND hm.status = 'ACTIVE' THEN 'OFF' ELSE 'ON' END,
          n.max_family_members,
          ARRAY(
            SELECT u2.dni FROM home_member hm2
              JOIN app_user u2 ON u2.id = hm2.user_id
             WHERE hm2.home_id = h.id AND u2.id <> u.id AND u2.dni IS NOT NULL
             ORDER BY u2.id
          )
        FROM app_user u
        JOIN home_member hm   ON hm.user_id = u.id
        JOIN home h           ON h.id = hm.home_id
        JOIN device d         ON d.id = h.default_device_id
        JOIN neighborhood n   ON n.id = h.neighborhood_id
       WHERE u.dni IS NOT NULL AND d.legacy_marker IS NOT NULL;
      $fn$
    `);

    // ── NOTIFY sobre event ────────────────────────────────────────────
    // No existía ningún canal para eventos: había para commands, config,
    // provisioning y panel_state, pero el evento —lo más urgente que pasa en
    // este sistema— no avisaba a nadie. El proyector necesita enterarse al
    // instante de que se abrió o se cerró una emergencia.
    //
    // NO es legacy: este canal le va a servir igual al backend de la app nueva
    // cuando exista (punto 14 de docs/estado-proyecto.md). Por eso se llama
    // `app_event` y no `legacy_event`, y por eso NO se borra con el resto del
    // puente. El payload es el device_id, que es lo que el proyector necesita
    // para saber qué marcador refrescar.
    //
    // Solo ante cambio REAL de status, mismo criterio que notify_panel_state:
    // un UPDATE que no mueve el estado no despierta a nadie.
    await queryRunner.query(`
      CREATE FUNCTION gtd.notify_app_event() RETURNS TRIGGER
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.device_id IS NULL THEN
          RETURN NEW;
        END IF;
        IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
          PERFORM pg_notify('app_event', NEW.device_id::TEXT);
        END IF;
        RETURN NEW;
      END;
      $fn$
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_event_notify
        AFTER INSERT OR UPDATE ON event
        FOR EACH ROW EXECUTE FUNCTION gtd.notify_app_event()
    `);

    // ------------------------------------------------------------------
    // 8. Permisos
    // ------------------------------------------------------------------
    // PUBLIC tiene EXECUTE por defecto en toda función nueva: sin este REVOKE,
    // revocarle a un rol puntual no sirve de nada.
    //
    // close_legacy_events no se le concede a NADIE: la llama insert_evento, que
    // es SECURITY DEFINER y por lo tanto corre como el dueño. Es el detalle que
    // mantiene en pie la regla — cps_alarms no puede resolver un evento ni
    // llamando a esta función directamente.
    await queryRunner.query(`
      REVOKE EXECUTE ON FUNCTION
        gtd.enqueue_legacy_alarm(TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION),
        gtd.close_legacy_events(INT, TEXT),
        gtd.legacy_snapshot(INT),
        gtd.legacy_devices(),
        gtd.legacy_clientes()
      FROM PUBLIC
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        -- El adaptador de la app vieja. Su ÚNICA capacidad es pedir una
        -- activación legacy: no lee la base, no encola comandos arbitrarios y
        -- no toca device_state.
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_legacy') THEN
          GRANT USAGE ON SCHEMA gtd TO cps_legacy;
          REVOKE ALL ON gtd.legacy_activation, gtd.legacy_mode_map FROM cps_legacy;
          GRANT EXECUTE ON FUNCTION
            gtd.enqueue_legacy_alarm(TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION),
            gtd.legacy_snapshot(INT),
            gtd.legacy_devices(),
            gtd.legacy_clientes()
          TO cps_legacy;
        END IF;

        -- La web LEE para mostrar en el panel de dónde vino una activación.
        -- No escribe: el mapa de modos lo cambia CPS por migración o a mano.
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_web') THEN
          REVOKE ALL ON gtd.legacy_activation, gtd.legacy_mode_map FROM cps_web;
          GRANT SELECT ON gtd.legacy_activation, gtd.legacy_mode_map TO cps_web;
        END IF;

        -- El GtD no participa: insert_evento es SECURITY DEFINER y lee la tabla
        -- como su dueño. El ALTER DEFAULT PRIVILEGES de roles-conexion-v2.sql
        -- le habría dado SELECT automático a toda tabla nueva; acá se lo saca.
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'cps_alarms') THEN
          REVOKE ALL ON gtd.legacy_activation, gtd.legacy_mode_map FROM cps_alarms;
        END IF;
      END
      $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // insert_evento vuelve EXACTA a la de GtdBridgeFunctions: sin el bloque de
    // la puerta vieja y sin gps/location_mode en el INSERT.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION gtd.insert_evento(
        p_mac     TEXT,
        p_tipo    TEXT,
        p_payload JSONB,
        p_eid     TEXT   DEFAULT NULL,
        p_ts      BIGINT DEFAULT NULL
      ) RETURNS BOOLEAN
      LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, gtd, pg_temp
      AS $fn$
      DECLARE
        v_device        device%ROWTYPE;
        v_ts            TIMESTAMPTZ := CASE WHEN p_ts IS NULL
                                            THEN NULL ELSE to_timestamp(p_ts) END;
        v_tsq           SMALLINT    := (p_payload->>'tsq')::SMALLINT;
        v_mode          TEXT        := p_payload->>'mode';
        v_dni           TEXT        := NULLIF(p_payload->>'dni', '0');
        v_origin        event_origin;
        v_user          app_user%ROWTYPE;
        v_home_id       INT;
        v_remote_id     INT;
        v_event_id      BIGINT;
        v_resultado     TEXT;
      BEGIN
        SELECT * INTO v_device FROM device WHERE mac = p_mac;

        v_resultado := CASE
          WHEN v_device.id IS NULL              THEN 'unknown_device'
          WHEN p_tipo <> 'alarma'               THEN 'sin_destino'
          WHEN v_mode = 'off'                   THEN 'desarme'
          WHEN v_device.neighborhood_id IS NULL THEN 'orphan'
          ELSE NULL
        END;

        IF v_resultado IS NOT NULL THEN
          INSERT INTO gtd.uplink_raw (mac, tipo, eid, payload, ts_device, tsq, resultado)
          VALUES (p_mac, p_tipo, p_eid, p_payload, v_ts, v_tsq, v_resultado);
          RETURN true;
        END IF;

        v_origin := CASE p_payload->>'origin'
          WHEN 'rf'     THEN 'REMOTE'
          WHEN 'mqtt'   THEN 'APP'
          WHEN 'auto'   THEN 'DEVICE'
          WHEN 'portal' THEN 'PANEL'
          ELSE 'DEVICE'
        END::event_origin;

        IF v_dni IS NOT NULL THEN
          SELECT * INTO v_user FROM app_user WHERE dni = v_dni;
          SELECT home_id INTO v_home_id
            FROM home_member WHERE user_id = v_user.id AND status = 'ACTIVE';
          SELECT id INTO v_remote_id
            FROM remote
           WHERE assigned_to_user_id = v_user.id AND device_id = v_device.id
           LIMIT 1;
        END IF;

        INSERT INTO event (
          neighborhood_id, device_id, home_id, remote_id,
          origin, trigger_mode, external_id, ts_device, tsq,
          activator_user_id, activator_name, activator_phone
        ) VALUES (
          v_device.neighborhood_id, v_device.id, v_home_id, v_remote_id,
          v_origin, v_mode, p_eid, v_ts, v_tsq,
          v_user.id, v_user.name, v_user.telephone
        )
        ON CONFLICT (device_id, external_id) WHERE external_id IS NOT NULL
        DO NOTHING
        RETURNING id INTO v_event_id;

        RETURN v_event_id IS NOT NULL;
      END;
      $fn$
    `);

    await queryRunner.query(`
      DROP FUNCTION IF EXISTS
        gtd.enqueue_legacy_alarm(TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION)
    `);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS gtd.close_legacy_events(INT, TEXT)`,
    );
    await queryRunner.query(`DROP TRIGGER IF EXISTS trg_event_notify ON event`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS gtd.notify_app_event()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS gtd.legacy_clientes()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS gtd.legacy_devices()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS gtd.legacy_snapshot(INT)`);
    await queryRunner.query(`DROP TABLE IF EXISTS gtd.legacy_activation`);
    await queryRunner.query(`DROP TABLE IF EXISTS gtd.legacy_mode_map`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_device_legacy_marker`);
    await queryRunner.query(`
      ALTER TABLE device DROP CONSTRAINT IF EXISTS chk_device_legacy_marker
    `);
    await queryRunner.query(
      `ALTER TABLE device DROP COLUMN IF EXISTS legacy_marker`,
    );
  }
}
