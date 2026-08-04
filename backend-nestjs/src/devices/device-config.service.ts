import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../common/audit.service';
import { AccessScope, ScopeService } from '../common/scope.service';
import { MAX_PAYLOAD_BYTES, validarPatch } from './device-config.limits';
import { DevicesService } from './devices.service';
import {
  DeviceConfigView,
  EstadoConfig,
  RedWifiRevelada,
  RedWifiView,
  ScanRedView,
  ScanView,
} from './dto/device-config.dto';

/** Filas crudas de las consultas al esquema `gtd`. */
interface EspejoRow {
  cfg_v: string;
  payload: Record<string, unknown>;
  updated_at: Date;
}
interface ColaRow {
  cfg_v: string;
  estado: string;
  detalle: string | null;
}
interface ScanRow {
  redes: ScanRedView[];
  received_at: Date;
}

/** Una red tal como vive en el JSONB del panel. */
interface RedCruda {
  ssid?: unknown;
  psw?: unknown;
  prio?: unknown;
}

/**
 * Configuración de un equipo.
 *
 * No hay tabla de configuración: `gtd.config_espejo` (lo que el panel DICE que
 * corre, después de los clamps silenciosos del firmware) es la verdad de
 * lectura, y `gtd.publish_config` el único camino de escritura.
 *
 * Ver `docs/superpowers/specs/2026-08-04-configuracion-por-equipo-design.md`.
 */
@Injectable()
export class DeviceConfigService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly devices: DevicesService,
    private readonly scopes: ScopeService,
    private readonly audit: AuditService,
  ) {}

  private async consultar<T>(
    sql: string,
    params: unknown[],
    manager?: EntityManager,
  ): Promise<T[]> {
    const runner = manager ?? this.dataSource;
    return runner.query(sql, params);
  }

  /** El equipo, con su barrio ya validado contra el alcance. Tira 403/404. */
  private async equipoVisible(id: number, scope: AccessScope) {
    const device = await this.devices.findOne(id, scope);
    if (!device.mac) {
      throw new ConflictException(
        'Este equipo no tiene MAC cargada: no se puede configurar',
      );
    }
    return device;
  }

  /** Además de verlo, ¿lo GESTIONA? Con managed_by = CPS la organización mira. */
  private async exigirGestion(
    id: number,
    scope: AccessScope,
  ): Promise<{ neighborhoodId: number }> {
    const device = await this.equipoVisible(id, scope);
    if (device.neighborhoodId === null) {
      throw new ConflictException(
        'Este equipo todavía no está instalado en ningún barrio',
      );
    }
    await this.scopes.assertManagesNeighborhood(scope, device.neighborhoodId);
    return { neighborhoodId: device.neighborhoodId };
  }

  private redesDe(payload: Record<string, unknown> | null): RedCruda[] {
    const redes = payload?.redes;
    return Array.isArray(redes) ? (redes as RedCruda[]) : [];
  }

  /** Las redes SIN password: se dice que hay una guardada, no cuál es. */
  private redesSinPassword(
    payload: Record<string, unknown> | null,
  ): RedWifiView[] {
    return this.redesDe(payload).map((red, i) => ({
      ssid: typeof red.ssid === 'string' ? red.ssid : '',
      prio: typeof red.prio === 'number' ? red.prio : i + 1,
      tienePassword: typeof red.psw === 'string' && red.psw.length > 0,
    }));
  }

  /** El espejo sin las redes: van aparte y ya saneadas. */
  private sinRedes(
    payload: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!payload) return null;
    const copia = { ...payload };
    delete copia.redes;
    return copia;
  }

  /**
   * Repone las passwords que el cliente no puede haber mandado.
   *
   * `publish_config` reemplaza el ARRAY ENTERO de redes (hace
   * `COALESCE(patch->'redes', base->'redes')`, no un merge red por red). Como el
   * GET nunca devuelve las passwords, guardar sin retipearlas las borraría
   * todas y el barrio entero se quedaría sin WiFi. Una red sin `psw` en el
   * patch conserva la del espejo; para cambiarla hay que mandar una nueva.
   */
  private rehidratarPasswords(
    patch: Record<string, unknown>,
    espejo: Record<string, unknown> | null,
  ): Record<string, unknown> {
    const redesPatch = patch.redes;
    if (!Array.isArray(redesPatch)) return patch;

    const guardadas = new Map<string, string>();
    for (const red of this.redesDe(espejo)) {
      if (typeof red.ssid === 'string' && typeof red.psw === 'string') {
        guardadas.set(red.ssid, red.psw);
      }
    }

    const rehidratadas = (redesPatch as RedCruda[]).map((red) => {
      if (typeof red.psw === 'string' && red.psw.length > 0) return red;
      const ssid = typeof red.ssid === 'string' ? red.ssid : '';
      const previa = guardadas.get(ssid);
      return previa === undefined ? red : { ...red, psw: previa };
    });

    return { ...patch, redes: rehidratadas };
  }

  private async leerEspejo(
    id: number,
    manager?: EntityManager,
  ): Promise<EspejoRow | undefined> {
    const filas = await this.consultar<EspejoRow>(
      `SELECT cfg_v, payload, updated_at FROM gtd.config_espejo WHERE device_id = $1`,
      [id],
      manager,
    );
    return filas[0];
  }

  async findConfig(id: number, scope: AccessScope): Promise<DeviceConfigView> {
    const device = await this.equipoVisible(id, scope);

    const espejo = await this.leerEspejo(id);
    const [cola] = await this.consultar<ColaRow>(
      `SELECT cfg_v, estado, detalle FROM gtd.panel_config WHERE device_id = $1`,
      [id],
    );
    const [scan] = await this.consultar<ScanRow>(
      `SELECT redes, received_at FROM gtd.last_scan($1)`,
      [id],
    );

    const payload = espejo?.payload ?? null;

    // DERIVADO, no guardado: "verificado" es que el espejo alcanzó a la cola.
    // Guardarlo sería un segundo lugar donde vive el mismo hecho.
    let estado: EstadoConfig;
    if (!espejo) {
      estado = 'SIN_ESPEJO';
    } else if (!cola) {
      estado = 'VERIFICADO';
    } else if (cola.estado === 'failed') {
      estado = 'FALLIDA';
    } else if (BigInt(espejo.cfg_v) >= BigInt(cola.cfg_v)) {
      estado = 'VERIFICADO';
    } else if (cola.estado === 'applied') {
      estado = 'APLICADA_SIN_VERIFICAR';
    } else if (cola.estado === 'sent') {
      estado = 'ENVIADA';
    } else {
      estado = 'PENDIENTE';
    }

    const ultimoScan: ScanView | null = scan
      ? { redes: scan.redes, recibidoEn: scan.received_at.toISOString() }
      : null;

    return {
      deviceId: id,
      estado,
      configuracion: this.sinRedes(payload),
      redes: this.redesSinPassword(payload),
      cfgVEspejo: espejo?.cfg_v ?? null,
      cfgVPendiente: cola?.cfg_v ?? null,
      detalle: cola?.detalle ?? null,
      espejoActualizadoEn: espejo?.updated_at.toISOString() ?? null,
      ultimoScan,
      puedeEditar:
        device.neighborhoodId !== null &&
        (await this.scopes.managesNeighborhood(scope, device.neighborhoodId)),
    };
  }

  async publish(
    id: number,
    patch: Record<string, unknown>,
    scope: AccessScope,
    userId: number,
  ): Promise<DeviceConfigView> {
    await this.exigirGestion(id, scope);

    const errores = validarPatch(patch);
    if (errores.length > 0) throw new BadRequestException(errores);

    // Todo adentro de una transacción: si el payload mergeado no entra en el
    // panel, se revierte y no queda nada. `pg_notify` es transaccional (entrega
    // en el COMMIT), así que el GtD nunca se entera del intento fallido y el
    // cfg_v tampoco se quema.
    const cfgV = await this.dataSource.transaction(async (manager) => {
      const espejo = await this.leerEspejo(id, manager);
      const conPasswords = this.rehidratarPasswords(
        patch,
        espejo?.payload ?? null,
      );

      let version: string;
      try {
        const [fila] = await this.consultar<{ cfg_v: string }>(
          `SELECT gtd.publish_config($1, $2::jsonb, $3) AS cfg_v`,
          [id, JSON.stringify(conPasswords), userId],
          manager,
        );
        version = String(fila.cfg_v);
      } catch (e) {
        // publish_config levanta excepciones con mensajes pensados para el
        // usuario (sin espejo, equipo sin MAC). El motor sabe mejor que nosotros
        // por qué no se puede: se traduce tal cual.
        throw new ConflictException((e as Error).message);
      }

      // El tamaño se mide sobre lo YA MERGEADO, que es lo que va a viajar:
      // medirlo sobre el patch no serviría, porque el merge le suma las
      // secciones completas que el panel exige.
      const [{ bytes }] = await this.consultar<{ bytes: string }>(
        `SELECT octet_length(payload::text) AS bytes FROM gtd.panel_config WHERE device_id = $1`,
        [id],
        manager,
      );
      if (Number(bytes) > MAX_PAYLOAD_BYTES) {
        throw new BadRequestException(
          `La configuración ocupa ${bytes} bytes y el equipo acepta hasta ` +
            `${MAX_PAYLOAD_BYTES}. Sacá alguna red WiFi o acortá las contraseñas.`,
        );
      }

      return version;
    });

    await this.audit.record({
      actorUserId: userId,
      action: 'device.config.publish',
      entityType: 'device',
      entityId: id,
      newValue: { cfgV, secciones: Object.keys(patch) },
    });

    return this.findConfig(id, scope);
  }

  private async encolar(
    id: number,
    tipo: 'scan' | 'refresh',
    scope: AccessScope,
    userId: number,
  ): Promise<void> {
    await this.exigirGestion(id, scope);
    await this.dataSource.query(
      `SELECT gtd.enqueue_command($1, $2, '{}'::jsonb, $3)`,
      [id, tipo, userId],
    );
  }

  /**
   * Que el equipo busque redes. A pedido y NUNCA automático: el scan interrumpe
   * la máquina de estados del WiFi y, mientras dura, el panel no está siendo una
   * alarma. El resultado no vuelve acá: llega después por `up t:scan`.
   */
  async pedirScan(
    id: number,
    scope: AccessScope,
    userId: number,
  ): Promise<{ mensaje: string }> {
    await this.encolar(id, 'scan', scope, userId);
    return {
      mensaje:
        'Se le pidió al equipo que busque redes. El resultado llega en unos segundos.',
    };
  }

  /** Pedirle el `cfg_full`. Es el desbloqueo cuando no hay espejo. */
  async pedirRefresh(
    id: number,
    scope: AccessScope,
    userId: number,
  ): Promise<{ mensaje: string }> {
    await this.encolar(id, 'refresh', scope, userId);
    return { mensaje: 'Se le pidió al equipo su configuración actual.' };
  }

  /**
   * Las passwords en claro. SOLO CPS y SIEMPRE auditado: es el único camino de
   * lectura que existe, justamente para que quede registrado quién miró.
   */
  async revelarWifi(
    id: number,
    scope: AccessScope,
    userId: number,
  ): Promise<RedWifiRevelada[]> {
    await this.equipoVisible(id, scope);

    const espejo = await this.leerEspejo(id);
    if (!espejo) {
      throw new ConflictException(
        'El equipo nunca reportó su configuración: no hay contraseñas que mostrar',
      );
    }

    await this.audit.record({
      actorUserId: userId,
      action: 'device.config.reveal_wifi',
      entityType: 'device',
      entityId: id,
    });

    return this.redesDe(espejo.payload).map((red) => ({
      ssid: typeof red.ssid === 'string' ? red.ssid : '',
      psw: typeof red.psw === 'string' ? red.psw : '',
    }));
  }
}
