import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/auth.service';
import { cumpleMembresia } from '../auth/decorators/roles.decorator';
import { CryptoService } from '../common/crypto.service';
import { RemoteStatus } from '../common/enums';
import { AccessScope, ScopeService } from '../common/scope.service';
import { CONFIGURAN_EQUIPOS } from '../devices/device-permissions';
import { DevicesService } from '../devices/devices.service';
import {
  BajaDeSync,
  ControlDeSync,
  ControlSinAlarma,
  ControlSalteado,
  EstadoRfView,
  TandaDeSync,
} from './dto/rf-sync.dto';
import { RemoteCode } from './entities/remote-code.entity';
import { Remote } from './entities/remote.entity';
import {
  ClienteDelPanel,
  EXPLICACION,
  armarPasos,
  capacidadDeRegistros,
  dniParaElPanel,
  explicarDetalle,
  hashDeCodigos,
  motivoDeSalteo,
} from './rf-sync';

interface FilaObjetivo {
  id: number;
  serial: string | null;
  status: RemoteStatus;
  direccion: string;
  portador: string | null;
  dni: string | null;
  synced_device_id: number | null;
  synced_dni: string | null;
  synced_hash: string | null;
}

/**
 * Cargar los códigos de los controles en la EEPROM del panel.
 *
 * ## Lo que esto arregla
 *
 * Asignar un control era, hasta acá, un acto administrativo: el vecino se
 * llevaba el llavero y el panel no lo conocía. **Un código que el panel no tiene
 * no dispara nada** — ni evento, ni sirena. Del otro lado, un control devuelto o
 * reportado como perdido seguía abriendo la alarma de esa gente. Esto cierra las
 * dos puntas.
 *
 * ## Qué controles le tocan a un equipo
 *
 * Los de las viviendas que lo tienen como **alarma preferida**
 * (`home.default_device_id`). No "todos los del barrio": en el chip entran ~126
 * vecinos y un barrio con 10 alarmas puede tener 1200 controles.
 *
 * ## Estado vs. hecho
 *
 * Acá se decide QUÉ mandar; que un control quede marcado como cargado lo hace
 * `gtd.confirm_command` cuando llega el ack, porque es el único momento en que
 * se sabe que el equipo lo guardó de verdad — y a esa altura del lado de Node no
 * corre nadie.
 */
@Injectable()
export class RfSyncService {
  constructor(
    @InjectRepository(Remote) private readonly remotes: Repository<Remote>,
    @InjectRepository(RemoteCode)
    private readonly codes: Repository<RemoteCode>,
    private readonly devices: DevicesService,
    private readonly scopes: ScopeService,
    private readonly crypto: CryptoService,
    private readonly dataSource: DataSource,
  ) {}

  /** Qué está cargado, qué falta y qué sobra. No manda nada. */
  async estado(
    deviceId: number,
    scope: AccessScope,
    user: AuthenticatedUser,
  ): Promise<EstadoRfView> {
    // Valida el alcance ANTES que nada: sin esto el plan contaría controles de
    // un equipo que este usuario no tiene por qué ver.
    const device = await this.devices.findOne(deviceId, scope);
    const plan = await this.planear(deviceId);
    const impedimento = await this.impedimento(device, scope, user);

    return {
      sinAlarma: await this.sinAlarmaPreferida(device.neighborhoodId),
      capacidad: {
        tope: plan.capacidad,
        ocupados: plan.alDia.length + plan.altas.length,
      },
      alDia: plan.alDia.length,
      pendientes: plan.altas.map((a) => a.vista),
      bajas: plan.bajas,
      salteados: plan.salteados,
      tanda: await this.tanda(deviceId),
      puedeSincronizar: impedimento === null,
      impedimento,
    };
  }

  /**
   * Arma el plan y lo encola. El resto lo maneja la cadena de la base: el
   * primer paso sale, y cada ack destraba el siguiente.
   */
  async sincronizar(
    deviceId: number,
    scope: AccessScope,
    user: AuthenticatedUser,
  ): Promise<EstadoRfView> {
    const device = await this.devices.findOne(deviceId, scope);
    const impedimento = await this.impedimento(device, scope, user);
    if (impedimento !== null) throw new ConflictException(impedimento);

    const plan = await this.planear(deviceId);
    const pasos = armarPasos(
      plan.bajas.map((b) => b.dni),
      plan.altas.map((a) => a.cliente),
    );

    if (pasos.length === 0) {
      throw new ConflictException(
        'No hay nada para sincronizar: el equipo ya tiene lo que le corresponde',
      );
    }

    await this.dataSource.query(
      `SELECT gtd.enqueue_rf_sync($1, $2::jsonb, $3)`,
      [deviceId, JSON.stringify(pasos), user.id],
    );

    return this.estado(deviceId, scope, user);
  }

  /**
   * Lo que hay que mandar, comparando lo que DEBERÍA estar contra lo que está.
   *
   * No hay ningún flag "pendiente" que mantener: la diferencia se calcula cada
   * vez. Por eso cambiar el portador, editar un código, devolver el control o
   * cambiarle la alarma preferida al hogar lo desincronizan solos.
   */
  private async planear(deviceId: number): Promise<{
    capacidad: number;
    alDia: FilaObjetivo[];
    altas: { vista: ControlDeSync; cliente: ClienteDelPanel }[];
    bajas: BajaDeSync[];
    salteados: ControlSalteado[];
  }> {
    const capacidad = await this.capacidad(deviceId);
    const objetivo = await this.objetivo(deviceId);
    const codigos = await this.codigosDe(objetivo.map((o) => o.id));

    const alDia: FilaObjetivo[] = [];
    const altas: { vista: ControlDeSync; cliente: ClienteDelPanel }[] = [];
    const salteados: ControlSalteado[] = [];

    for (const fila of objetivo) {
      const suyos = codigos.get(fila.id) ?? [];
      const motivo = motivoDeSalteo({ dni: fila.dni, codigos: suyos });
      if (motivo !== null) {
        salteados.push({
          ...this.vista(fila),
          motivo,
          explicacion: EXPLICACION[motivo],
        });
        continue;
      }

      const hash = hashDeCodigos(suyos);
      const cargado =
        fila.synced_device_id === deviceId &&
        fila.synced_dni === fila.dni &&
        Number(fila.synced_hash) === hash;

      if (cargado) {
        alDia.push(fila);
        continue;
      }

      altas.push({
        vista: this.vista(fila),
        cliente: {
          remoteId: fila.id,
          dni: dniParaElPanel(fila.dni) as number,
          hash,
          codigos: suyos
            .sort((a, b) => a.position - b.position)
            .map((c) => c.codigo),
        },
      });
    }

    // El chip tiene fondo. Los que no entran se dicen, no se mandan: el equipo
    // cortaría la tanda con EE_FULL a mitad de camino y quedaría a medio cargar.
    const lugar = capacidad - alDia.length;
    if (altas.length > lugar) {
      for (const sobrante of altas.splice(Math.max(0, lugar))) {
        salteados.push({
          ...sobrante.vista,
          motivo: 'NO_ENTRA',
          explicacion: EXPLICACION.NO_ENTRA,
        });
      }
    }

    return {
      capacidad,
      alDia,
      altas,
      bajas: await this.bajas(deviceId, alDia),
      salteados,
    };
  }

  /**
   * Los controles que le corresponden a este equipo.
   *
   * Solo `ACTIVE`: un control `LOST` o `SUSPENDED` **no tiene que estar en el
   * panel**. Reportar un llavero perdido y que siga abriendo la alarma del
   * barrio es justamente el agujero que esto viene a tapar.
   */
  private objetivo(deviceId: number): Promise<FilaObjetivo[]> {
    return this.dataSource.query<FilaObjetivo[]>(
      `SELECT r.id, r.serial, r.status, h.address AS direccion,
              u.name AS portador, u.dni,
              r.synced_device_id, r.synced_dni, r.synced_hash
         FROM remote r
         JOIN home h ON h.id = r.home_id
         LEFT JOIN app_user u ON u.id = r.assigned_to_user_id
        WHERE h.default_device_id = $1
          AND r.removed_at IS NULL
          AND r.status = $2
        ORDER BY r.serial NULLS LAST, r.id`,
      [deviceId, RemoteStatus.ACTIVE],
    );
  }

  /**
   * Lo que hay que SACAR del equipo: todo lo que dice estar cargado ahí y no
   * quedó al día.
   *
   * Cubre de un saque los cinco casos, sin preguntarle a cada uno por qué:
   * devuelto al stock, removido, reportado perdido, cambiado de portador y
   * cambiado de códigos. Los dos últimos necesitan la baja aunque después
   * vuelvan a entrar — `op:batch` es alta pura y chocaría con `EE_DUP`.
   */
  private async bajas(
    deviceId: number,
    alDia: FilaObjetivo[],
  ): Promise<BajaDeSync[]> {
    const quedan = new Set(alDia.map((f) => f.id));
    const cargados = await this.remotes.find({
      where: { syncedDeviceId: deviceId },
      select: {
        id: true,
        serial: true,
        status: true,
        homeId: true,
        removedAt: true,
        syncedDni: true,
        assignedToUserId: true,
      },
    });

    return cargados
      .filter((r) => !quedan.has(r.id))
      .map((r) => ({
        dni: r.syncedDni as string,
        serial: r.serial,
        motivo: this.porQueSobra(r),
      }));
  }

  private porQueSobra(r: Remote): string {
    if (r.removedAt !== null) return 'se removió del sistema';
    if (r.homeId === null) return 'volvió al stock';
    if (r.status === RemoteStatus.LOST) return 'se reportó perdido';
    if (r.status !== RemoteStatus.ACTIVE) return `quedó en estado ${r.status}`;
    if (r.assignedToUserId === null) return 'se quedó sin portador';
    // Sigue vivo y en su casa: o cambió de portador, o le tocaron los códigos,
    // o su hogar cambió de alarma preferida. En los tres, la baja va seguida
    // del alta con lo nuevo.
    return 'cambió y hay que volver a cargarlo';
  }

  /**
   * Los controles del barrio que no le tocan a NINGÚN equipo.
   *
   * Su vivienda no eligió alarma preferida, así que quedan fuera del plan de
   * todos los paneles: el vecino tiene el llavero y ninguna alarma lo conoce.
   * Pasa siempre que la casa se cargó antes de que el barrio tuviera alarmas —el
   * combo del alta estaba vacío— y hasta acá no se avisaba en ningún lado: la
   * pantalla mostraba cero pendientes, que es indistinguible de "todo al día".
   *
   * Se listan en la pantalla de CUALQUIER equipo del barrio a propósito. No son
   * de este, pero esta es la pantalla donde alguien se pregunta por qué no
   * aparece el control que acaba de asignar.
   */
  private sinAlarmaPreferida(
    neighborhoodId: number | null,
  ): Promise<ControlSinAlarma[]> {
    if (neighborhoodId === null) return Promise.resolve([]);

    return this.dataSource.query<ControlSinAlarma[]>(
      `SELECT r.id AS "remoteId", r.serial, h.id AS "homeId",
              h.address AS direccion
         FROM remote r
         JOIN home h ON h.id = r.home_id
        WHERE h.neighborhood_id = $1
          AND h.default_device_id IS NULL
          AND r.removed_at IS NULL
          AND r.status = $2
        ORDER BY h.address, r.serial`,
      [neighborhoodId, RemoteStatus.ACTIVE],
    );
  }

  /** Los códigos EN CLARO, por control. Se descifran acá y no salen de acá. */
  private async codigosDe(
    remoteIds: number[],
  ): Promise<Map<number, { position: number; codigo: number }[]>> {
    const porControl = new Map<
      number,
      { position: number; codigo: number }[]
    >();
    if (remoteIds.length === 0) return porControl;

    const filas = await this.codes.find({
      where: { remoteId: In(remoteIds) },
      select: { id: true, remoteId: true, position: true, codeEncrypted: true },
      order: { position: 'ASC' },
    });

    for (const fila of filas) {
      const lista = porControl.get(fila.remoteId) ?? [];
      lista.push({
        position: fila.position,
        codigo: Number(this.crypto.decrypt(fila.codeEncrypted)),
      });
      porControl.set(fila.remoteId, lista);
    }
    return porControl;
  }

  /**
   * Cuántos vecinos entran, según el chip que el equipo REPORTA tener.
   *
   * Sale de la telemetría (`modulos.eeprom.kb`). Sin telemetría se asume el más
   * chico: que sobre lugar es un problema menor que un `EE_FULL` a mitad de una
   * tanda.
   */
  private async capacidad(deviceId: number): Promise<number> {
    const [fila] = await this.dataSource.query<{ kb: number | null }[]>(
      `SELECT (tele->'modulos'->'eeprom'->>'kb')::INT AS kb
         FROM device_state WHERE device_id = $1`,
      [deviceId],
    );
    return capacidadDeRegistros(fila?.kb);
  }

  /** La tanda en curso, o la última que terminó. */
  private async tanda(deviceId: number): Promise<TandaDeSync | null> {
    const [fila] = await this.dataSource.query<
      {
        batch_id: string;
        total: string;
        hechos: string;
        pendientes: string;
        errores: string;
        detalle: string | null;
        empezada: Date;
      }[]
    >(
      `SELECT batch_id,
              COUNT(*)                                        AS total,
              COUNT(*) FILTER (WHERE estado = 'ok')           AS hechos,
              COUNT(*) FILTER (WHERE estado IN ('queued','pending','sent')) AS pendientes,
              COUNT(*) FILTER (WHERE estado = 'error')        AS errores,
              MIN(detalle) FILTER (WHERE estado = 'error')    AS detalle,
              MIN(created_at)                                 AS empezada
         FROM gtd.commands
        WHERE device_id = $1 AND tipo = 'rf' AND batch_id IS NOT NULL
        GROUP BY batch_id
        ORDER BY MIN(created_at) DESC
        LIMIT 1`,
      [deviceId],
    );
    if (!fila) return null;

    return {
      batchId: fila.batch_id,
      total: Number(fila.total),
      hechos: Number(fila.hechos),
      estado:
        Number(fila.pendientes) > 0
          ? 'en_curso'
          : Number(fila.errores) > 0
            ? 'con_error'
            : 'terminada',
      detalle: explicarDetalle(fila.detalle),
      empezada: fila.empezada.toISOString(),
    };
  }

  /**
   * Por qué no se puede sincronizar, si no se puede.
   *
   * Devuelve el motivo en vez de tirar: la pantalla necesita mostrar el estado
   * igual —saber qué falta es útil aunque no puedas mandarlo— y además así el
   * botón se explica en vez de aparecer deshabilitado sin razón.
   */
  private async impedimento(
    device: { id: number; mac: string | null; neighborhoodId: number | null },
    scope: AccessScope,
    user: AuthenticatedUser,
  ): Promise<string | null> {
    if (!device.mac) {
      return 'Este equipo no tiene MAC cargada: no se le pueden mandar comandos';
    }
    if (device.neighborhoodId === null) {
      return 'Este equipo todavía no está instalado en ningún barrio';
    }
    if (
      !(await this.scopes.managesNeighborhood(scope, device.neighborhoodId))
    ) {
      return 'Vos ves este barrio, pero no lo gestionás';
    }
    if (!cumpleMembresia(user.memberships, CONFIGURAN_EQUIPOS)) {
      return 'Tu rol no configura equipos';
    }

    const [enVuelo] = await this.dataSource.query<{ n: string }[]>(
      `SELECT COUNT(*) AS n FROM gtd.commands
        WHERE device_id = $1 AND tipo = 'rf'
          AND estado IN ('queued', 'pending', 'sent')`,
      [device.id],
    );
    if (Number(enVuelo.n) > 0) {
      return 'Ya hay una sincronización en curso para este equipo';
    }

    return null;
  }

  private vista(fila: FilaObjetivo): ControlDeSync {
    return {
      remoteId: fila.id,
      serial: fila.serial,
      direccion: fila.direccion,
      portador: fila.portador,
      dni: fila.dni,
    };
  }
}
