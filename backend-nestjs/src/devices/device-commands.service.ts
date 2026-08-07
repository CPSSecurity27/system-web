import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../auth/auth.service';
import { cumpleMembresia } from '../auth/decorators/roles.decorator';
import { AccessScope, ScopeService } from '../common/scope.service';
import {
  armarComando,
  MODOS_ALARMA,
  ModoAlarma,
  TipoComando,
} from './device-commands';
import {
  ACTUALIZAN_FIRMWARE,
  CONFIGURAN_EQUIPOS,
  DISPARAN_ALARMA,
} from './device-permissions';
import { ColaComandosView } from './dto/device-command.dto';
import { DevicesService } from './devices.service';

interface ComandoRow {
  cid: string;
  tipo: string;
  payload: Record<string, unknown>;
  estado: string;
  detalle: string | null;
  created_at: Date;
  sent_at: Date | null;
  confirmed_at: Date | null;
  pedido_por: string | null;
}

/**
 * Comandos al panel: la puerta única a `gtd.enqueue_command`.
 *
 * Un comando no es una configuración: no tiene versión, no se mergea y no se
 * reintenta solo. Se encola, el GtD lo publica en `av/<id>/cmd` y el panel
 * contesta con un `up t:ack` que trae el mismo `cid`.
 *
 * Por eso hay una pantalla que los muestra: sin ella, un comando que quedó
 * `pending` porque el equipo está dormido es indistinguible de uno que nunca se
 * mandó, y quien apretó el botón no tiene forma de saber cuál de las dos.
 */
@Injectable()
export class DeviceCommandsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly devices: DevicesService,
    private readonly scopes: ScopeService,
  ) {}

  /** Ve el equipo, tiene MAC, está instalado y el usuario GESTIONA su barrio. */
  private async equipoGobernable(id: number, scope: AccessScope) {
    const device = await this.devices.findOne(id, scope);
    if (!device.mac) {
      throw new ConflictException(
        'Este equipo no tiene MAC cargada: no se le pueden mandar comandos',
      );
    }
    if (device.neighborhoodId === null) {
      throw new ConflictException(
        'Este equipo todavía no está instalado en ningún barrio',
      );
    }
    await this.scopes.assertManagesNeighborhood(scope, device.neighborhoodId);
    return device;
  }

  private async encolar(
    deviceId: number,
    tipo: string,
    payload: Record<string, unknown>,
    userId: number,
  ): Promise<string> {
    const [fila] = await this.dataSource.query<{ cid: string }[]>(
      `SELECT gtd.enqueue_command($1, $2, $3::jsonb, $4) AS cid`,
      [deviceId, tipo, JSON.stringify(payload), userId],
    );
    return fila.cid;
  }

  /**
   * Encola un comando de infraestructura.
   *
   * `confirmacion` solo la mira `factory`: el firmware exige que el `confirm`
   * traiga el ID del equipo, y acá se exige además que la persona lo haya
   * tipeado. El backend podría completarlo solo —sabe el serial— pero entonces
   * el botón más destructivo del sistema sería un clic.
   */
  async mandar(
    id: number,
    tipo: TipoComando,
    params: Record<string, unknown>,
    confirmacion: string | undefined,
    scope: AccessScope,
    user: AuthenticatedUser,
  ): Promise<ColaComandosView> {
    const device = await this.equipoGobernable(id, scope);

    // El OTA es más chico que el resto: instala SOFTWARE, no cambia una
    // configuración. Con `fuente: "url"` además elige de dónde baja, y la
    // allowlist del firmware solo garantiza el host — no qué .bin hay ahí.
    // El guard del controlador deja pasar a la organización; esto no.
    if (
      tipo === 'ota' &&
      !cumpleMembresia(user.memberships, ACTUALIZAN_FIRMWARE)
    ) {
      throw new ForbiddenException(
        'Actualizar el firmware es de CPS: es el software de la infraestructura, ' +
          'no una configuración del barrio',
      );
    }

    if (tipo === 'factory' && confirmacion?.trim() !== device.serial) {
      throw new BadRequestException(
        `Para volver el equipo a fábrica hay que escribir su serial (${device.serial}) tal cual`,
      );
    }

    const { payload, errores } = armarComando(tipo, params, device.serial);
    if (errores.length > 0) throw new BadRequestException(errores);

    await this.encolar(id, tipo, payload, user.id);
    return this.listar(id, scope, user);
  }

  /**
   * Disparar o apagar la alarma a distancia.
   *
   * Va por su propia puerta y no por `mandar`: no es infraestructura, es una
   * acción de MONITOREO —la usa quien está mirando el tablero cuando pasa algo—
   * y por eso el MONITOR la tiene y el resto de los comandos no.
   *
   * El resultado NO vuelve por acá. El ack dice "acepté", y lo que realmente
   * pasó llega después como un `up t:alarma` con `origin: "mqtt"`, que el GtD
   * convierte en un `event` igual que si lo hubiera disparado un vecino. Un
   * disparo remoto no es un evento de otra especie.
   */
  async disparar(
    id: number,
    modo: ModoAlarma,
    scope: AccessScope,
    user: AuthenticatedUser,
  ): Promise<ColaComandosView> {
    await this.equipoGobernable(id, scope);

    if (!MODOS_ALARMA.includes(modo)) {
      throw new BadRequestException(`El modo "${modo}" no existe`);
    }

    await this.encolar(id, 'alarma', { mode: modo }, user.id);
    return this.listar(id, scope, user);
  }

  /**
   * Los últimos comandos del equipo, con los permisos ya resueltos.
   *
   * Solo pide VER el equipo: mirar qué se le pidió es parte de entender qué le
   * está pasando, y el MONITOR necesita eso tanto como el técnico. Lo que puede
   * HACER va en los TRES flags, calculados con las mismas listas que usan los
   * guards — para que la pantalla no ofrezca un botón que el backend rechaza.
   *
   * Son tres y no dos desde que el OTA quedó restringido a CPS: un técnico
   * municipal reinicia y vuelve a fábrica sus postes, pero no les instala
   * firmware.
   */
  async listar(
    id: number,
    scope: AccessScope,
    user: AuthenticatedUser,
  ): Promise<ColaComandosView> {
    const device = await this.devices.findOne(id, scope);

    const gobernable =
      device.mac !== null &&
      device.neighborhoodId !== null &&
      (await this.scopes.managesNeighborhood(scope, device.neighborhoodId));

    const filas = await this.dataSource.query<ComandoRow[]>(
      `SELECT c.cid, c.tipo, c.payload, c.estado, c.detalle,
              c.created_at, c.sent_at, c.confirmed_at,
              u.name AS pedido_por
         FROM gtd.commands c
         LEFT JOIN app_user u ON u.id = c.requested_by
        WHERE c.device_id = $1
        ORDER BY c.created_at DESC
        LIMIT 20`,
      [id],
    );

    return {
      comandos: filas.map((f) => ({
        cid: f.cid,
        tipo: f.tipo,
        payload: f.payload,
        estado: f.estado,
        detalle: f.detalle,
        creadoEn: f.created_at.toISOString(),
        enviadoEn: f.sent_at?.toISOString() ?? null,
        confirmadoEn: f.confirmed_at?.toISOString() ?? null,
        pedidoPor: f.pedido_por,
        // Un comando ya publicado en el broker no se puede "desmandar": el panel
        // lo va a recibir igual. Cancelar solo sirve mientras sigue en la cola.
        cancelable: f.estado === 'pending',
      })),
      puedeOperar:
        gobernable && cumpleMembresia(user.memberships, CONFIGURAN_EQUIPOS),
      puedeDisparar:
        gobernable && cumpleMembresia(user.memberships, DISPARAN_ALARMA),
      puedeActualizar:
        gobernable && cumpleMembresia(user.memberships, ACTUALIZAN_FIRMWARE),
    };
  }

  /** Solo si sigue `pending`. Un comando enviado no se cancela: se compensa. */
  async cancelar(
    id: number,
    cid: string,
    scope: AccessScope,
    user: AuthenticatedUser,
  ): Promise<ColaComandosView> {
    await this.equipoGobernable(id, scope);

    const [fila] = await this.dataSource.query<{ device_id: number }[]>(
      `SELECT device_id FROM gtd.commands WHERE cid = $1`,
      [cid],
    );
    // El cid es global, así que sin esto se podría cancelar el comando de un
    // equipo ajeno pasando el id de uno propio.
    if (!fila || fila.device_id !== id) {
      throw new NotFoundException('Ese comando no es de este equipo');
    }

    const [res] = await this.dataSource.query<{ cancel_command: boolean }[]>(
      `SELECT gtd.cancel_command($1, $2)`,
      [cid, user.id],
    );
    if (!res.cancel_command) {
      throw new ConflictException(
        'El comando ya salió hacia el equipo: no se puede cancelar',
      );
    }

    return this.listar(id, scope, user);
  }
}
