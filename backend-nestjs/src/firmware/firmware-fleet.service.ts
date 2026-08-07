import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../auth/auth.service';
import { AccessScope } from '../common/scope.service';
import { DeviceCommandsService } from '../devices/device-commands.service';
import {
  EquipoFirmwareView,
  ResultadoActualizacionView,
} from './dto/firmware.dto';
import {
  armarProgreso,
  confirmarActualizacion,
  OtaProgresoView,
} from './ota-estados';
import { FirmwareService } from './firmware.service';

interface FilaFlota {
  device_id: number;
  serial: string;
  nombre: string | null;
  neighborhood_id: number | null;
  barrio: string | null;
  cuenta: string | null;
  fw: string | null;
  online: boolean | null;
  sleep_until: Date | null;
  power_mode: string | null;
  // Necesario para confirmar una actualización: sin una señal POSTERIOR al
  // reinicio, lo que sabemos del equipo es de antes de que se reiniciara.
  last_seen: Date | null;
  ota_cid: string | null;
  ota_estado: string | null;
  ota_detalle: string | null;
  ota_creado: Date | null;
  // Lo que el EQUIPO contó de su propia actualización (up t:ota), que es otra
  // cosa que el estado del comando: el comando puede decir "confirmado" y la
  // descarga estar a mitad de camino.
  prog_estado: number | null;
  prog_resultado: number | null;
  prog_fw: string | null;
  prog_at: Date | null;
}

/**
 * El gestor de actualizaciones: qué versión corre cada poste y mandarles la
 * nueva.
 *
 * ## Esto NO es una campaña
 *
 * Las campañas masivas están descartadas y no se reabren. Acá una persona mira
 * la flota, tilda equipos y aprieta: **cada equipo recibe su propio comando con
 * su propio `cid`**, exactamente el mismo que si se hubiera entrado a su ficha.
 * No hay broadcast (`av/all/cmd` está prohibido por el diseño del firmware), no
 * hay reintento automático y nada se dispara solo.
 *
 * La diferencia con apretar treinta veces es la pantalla, no el mecanismo.
 *
 * ## Por qué "desconocido" no es "atrasado"
 *
 * `device_state.fw` llega por el `status` retained, así que un equipo que nunca
 * conectó no tiene ninguno. Meterlo en la bolsa de los atrasados haría que la
 * pantalla proponga actualizar postes que ni siquiera existen todavía en el
 * broker.
 */
@Injectable()
export class FirmwareFleetService {
  private readonly logger = new Logger(FirmwareFleetService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly firmware: FirmwareService,
    private readonly commands: DeviceCommandsService,
  ) {}

  /**
   * La flota con su versión, comparada contra la publicada en `new`.
   *
   * La lista sale recortada por alcance aunque hoy el endpoint sea solo-CPS
   * (y CPS vea todo): el recorte no es una consecuencia del permiso, es una
   * propiedad del listado. Si mañana alguien más entra acá, ya está puesto.
   */
  async flota(
    scope: AccessScope,
    filtros: { neighborhoodId?: number } = {},
  ): Promise<{ publicada: string | null; equipos: EquipoFirmwareView[] }> {
    const publicada = await this.firmware.versionPublicada();

    const condiciones: string[] = [
      'd.removed_at IS NULL',
      'd.mac IS NOT NULL',
      'd.neighborhood_id IS NOT NULL',
    ];
    const params: unknown[] = [];

    if (!scope.global) {
      if (scope.neighborhoodIds.length === 0) {
        return { publicada, equipos: [] };
      }
      params.push(scope.neighborhoodIds);
      condiciones.push(`d.neighborhood_id = ANY($${params.length})`);
    }

    // El filtro va ENCIMA del alcance, nunca en lugar de él: un barrio ajeno
    // devuelve vacío, no los equipos de ese barrio.
    if (filtros.neighborhoodId) {
      params.push(filtros.neighborhoodId);
      condiciones.push(`d.neighborhood_id = $${params.length}`);
    }

    const filas = await this.dataSource.query<FilaFlota[]>(
      `SELECT d.id                AS device_id,
              d.serial,
              d.name              AS nombre,
              d.neighborhood_id,
              n.name              AS barrio,
              a.name              AS cuenta,
              s.fw,
              s.online,
              s.sleep_until,
              s.power_mode,
              s.last_seen,
              c.cid               AS ota_cid,
              c.estado            AS ota_estado,
              c.detalle           AS ota_detalle,
              c.created_at        AS ota_creado,
              p.estado            AS prog_estado,
              p.resultado         AS prog_resultado,
              p.fw                AS prog_fw,
              p.received_at       AS prog_at
         FROM device d
         LEFT JOIN device_state  s ON s.device_id = d.id
         LEFT JOIN neighborhood  n ON n.id = d.neighborhood_id
         LEFT JOIN account       a ON a.id = n.organization_id
         -- El último OTA sin cerrar, si hay. LATERAL y no un JOIN con subquery
         -- para que sea una fila por equipo sin agrupar todo lo demás.
         LEFT JOIN LATERAL (
           SELECT cc.cid, cc.estado, cc.detalle, cc.created_at
             FROM gtd.commands cc
            WHERE cc.device_id = d.id
              AND cc.tipo = 'ota'
              AND cc.estado IN ('queued', 'pending', 'sent')
            ORDER BY cc.created_at DESC
            LIMIT 1
         ) c ON true
         -- Lo que contó el propio equipo. Función y no tabla: uplink_raw no es
         -- legible por cps_web —tiene los cfg_full con las passwords WiFi— así
         -- que la lectura pasa por gtd.last_ota, que expone solo esto.
         LEFT JOIN LATERAL gtd.last_ota(d.id) p ON true
        WHERE ${condiciones.join(' AND ')}
        ORDER BY n.name ASC, d.name ASC, d.serial ASC`,
      params,
    );

    return {
      publicada,
      equipos: filas.map((f) => ({
        deviceId: f.device_id,
        serial: f.serial,
        nombre: f.nombre,
        barrioId: f.neighborhood_id,
        barrio: f.barrio,
        cuenta: f.cuenta,
        fw: f.fw,
        estado: this.clasificar(f.fw, publicada),
        online: f.online === true,
        durmiendoHasta: f.sleep_until?.toISOString() ?? null,
        modoEnergia: f.power_mode,
        otaEnCurso: f.ota_cid
          ? {
              cid: f.ota_cid,
              estado: f.ota_estado ?? 'pending',
              detalle: f.ota_detalle,
              creadoEn: (f.ota_creado ?? new Date()).toISOString(),
            }
          : null,
        // El ack del comando dice "acepté el pedido". Esto dice cómo le está
        // yendo de verdad, y son dos cosas distintas: entre una y otra hay una
        // descarga de 1,2 MB, un sha256 y un reinicio.
        progreso: this.progresoDe(f),
        // Lo más fuerte que se puede AFIRMAR, que es bastante menos que "anda
        // bien": el self-test del equipo comprueba únicamente que consiguió
        // internet, y la versión que reporta es la etiqueta de nuestro propio
        // manifiesto devuelta.
        confirmacion: confirmarActualizacion({
          progreso: this.progresoDe(f),
          fwActual: f.fw,
          ultimaSenal: f.last_seen,
        }),
      })),
    };
  }

  private progresoDe(f: FilaFlota) {
    return f.prog_estado === null || f.prog_at === null
      ? null
      : armarProgreso({
          estado: f.prog_estado,
          resultado: f.prog_resultado ?? 0,
          fw: f.prog_fw,
          received_at: f.prog_at,
        });
  }

  /** El último `up t:ota` de un equipo, para la pestaña Acciones de su ficha. */
  async progreso(
    deviceId: number,
    scope: AccessScope,
  ): Promise<OtaProgresoView | null> {
    // El alcance no es decorativo aunque el endpoint sea solo-CPS: si mañana
    // alguien más entra acá, el recorte ya está puesto.
    if (!scope.global && !scope.neighborhoodIds.length) return null;

    const [fila] = await this.dataSource.query<
      {
        estado: number;
        resultado: number;
        fw: string | null;
        received_at: Date;
      }[]
    >(`SELECT * FROM gtd.last_ota($1)`, [deviceId]);

    return fila ? armarProgreso(fila) : null;
  }

  /**
   * Sin versión publicada NADA está atrasado: no hay contra qué comparar, y
   * pintar la flota entera de rojo porque todavía no se publicó nada es ruido.
   */
  private clasificar(
    fw: string | null,
    publicada: string | null,
  ): EquipoFirmwareView['estado'] {
    if (!fw) return 'desconocido';
    if (!publicada) return 'desconocido';
    return fw === publicada ? 'al_dia' : 'atrasado';
  }

  /**
   * Manda el OTA a los equipos elegidos, de a uno.
   *
   * Cada uno pasa por `DeviceCommandsService.mandar`, que es la puerta única a
   * `gtd.enqueue_command`: valida el alcance del barrio, arma el payload y deja
   * su `audit_log`. Acá no se saltea ninguna de esas verificaciones — el ahorro
   * es de clics, no de controles.
   *
   * **Un fallo no cancela al resto y se informa equipo por equipo.** Es
   * prácticamente seguro que algunos reboten: el firmware rechaza el OTA si el
   * equipo no está en modo de energía activo, y de noche un poste solar no lo
   * está. Un "listo" global sobre eso sería falso.
   */
  async actualizar(
    deviceIds: number[],
    scope: AccessScope,
    user: AuthenticatedUser,
  ): Promise<ResultadoActualizacionView[]> {
    const publicada = await this.firmware.versionPublicada();
    if (!publicada) {
      throw new BadRequestException(
        'No hay ninguna versión publicada como "new": el equipo bajaría de una carpeta vacía',
      );
    }

    const unicos = [...new Set(deviceIds)];
    const resultados: ResultadoActualizacionView[] = [];

    for (const id of unicos) {
      const [fila] = await this.dataSource.query<{ serial: string }[]>(
        `SELECT serial FROM device WHERE id = $1`,
        [id],
      );
      const serial = fila?.serial ?? String(id);

      try {
        // `fuente: auto` y no la URL de la versión: el equipo baja de
        // /ota/new/, que es la ranura que acabamos de publicar. Mandar la URL
        // de la carpeta de la versión funcionaría igual, pero entonces cada
        // comando quedaría clavado a una versión en la cola y republicar `new`
        // no lo cambiaría.
        const cola = await this.commands.mandar(
          id,
          'ota',
          { fuente: 'auto' },
          undefined,
          scope,
          user,
        );
        resultados.push({
          deviceId: id,
          serial,
          encolado: true,
          cid: cola.comandos[0]?.cid ?? null,
          motivo: null,
        });
      } catch (e) {
        const motivo =
          e instanceof Error ? this.mensaje(e) : 'No se pudo encolar';
        this.logger.warn(`OTA no encolado para el equipo ${id}: ${motivo}`);
        resultados.push({
          deviceId: id,
          serial,
          encolado: false,
          cid: null,
          motivo,
        });
      }
    }

    return resultados;
  }

  /** El mensaje de una HttpException de Nest viene adentro de `response`. */
  private mensaje(e: Error): string {
    const respuesta = (e as { response?: unknown }).response;
    if (typeof respuesta === 'string') return respuesta;
    if (respuesta && typeof respuesta === 'object') {
      const msg = (respuesta as { message?: unknown }).message;
      if (typeof msg === 'string') return msg;
      if (Array.isArray(msg)) return msg.join('. ');
    }
    return e.message;
  }
}
