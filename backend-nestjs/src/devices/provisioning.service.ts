import {
  ConflictException,
  Inject,
  Injectable,
  forwardRef,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AccessScope, ScopeService } from '../common/scope.service';
import { DevicesService } from './devices.service';

export type ProvisioningOp = 'provision' | 'revoke' | 'manufacture';
export type ProvisioningEstado = 'pending' | 'done' | 'failed';

/** Cada cuánto se mira la fila mientras se espera al provisioner. */
const SONDEO_MS = 250;

export interface ProvisioningQueueView {
  op: ProvisioningOp;
  estado: ProvisioningEstado;
  detalle: string | null;
  createdAt: string;
}

interface ColaRow {
  op: ProvisioningOp;
  estado: ProvisioningEstado;
  detalle: string | null;
  created_at: Date;
}

/**
 * Alta y baja de la credencial del equipo en el broker MQTT.
 *
 * La web NO registra nada: encola en `gtd.provisioning_queue` y un proceso
 * aparte (el provisioner, en el repo del GtD) hace el trabajo con privilegios
 * que la web no tiene ni tiene por qué tener. Acá nunca se ve el `SALT_MQTT` —
 * quien lo tiene puede calcular la credencial de toda la flota.
 *
 * Ver `docs/superpowers/specs/2026-08-04-provisioner-broker-design.md`.
 */
@Injectable()
export class ProvisioningService {
  constructor(
    private readonly dataSource: DataSource,
    // El otro lado del círculo: el alta de un equipo encola su credencial, y
    // encolar necesita resolver el equipo. Nest exige el forwardRef en LOS DOS.
    @Inject(forwardRef(() => DevicesService))
    private readonly devices: DevicesService,
    private readonly scopes: ScopeService,
  ) {}

  /**
   * Encola una operación.
   *
   * Con `manager` participa de la transacción de quien llama — así el alta del
   * equipo y su encolado son atómicos: no puede quedar un equipo fabricado sin
   * pedido de credencial.
   */
  async encolar(
    deviceId: number,
    op: ProvisioningOp,
    userId: number | null,
    manager?: EntityManager,
  ): Promise<number> {
    const runner = manager ?? this.dataSource;
    try {
      const filas: { id: string }[] = await runner.query(
        `SELECT gtd.enqueue_provisioning($1, $2, $3) AS id`,
        [deviceId, op, userId],
      );
      return Number(filas[0].id);
    } catch (e) {
      // La función levanta excepciones con mensajes pensados para el usuario
      // ("no existe o no tiene MAC cargada"): se traducen tal cual.
      throw new ConflictException((e as Error).message);
    }
  }

  /**
   * Pedido por una persona. El ROL lo valida el controller
   * (`@RequireMembership`); el ALCANCE, acá. Los dos, siempre.
   */
  async pedir(
    deviceId: number,
    op: ProvisioningOp,
    scope: AccessScope,
    userId: number,
  ): Promise<{ mensaje: string }> {
    const device = await this.devices.findOne(deviceId, scope);
    if (device.neighborhoodId !== null) {
      this.scopes.assertNeighborhood(scope, device.neighborhoodId);
    }

    await this.encolar(deviceId, op, userId);
    return {
      mensaje:
        op === 'provision'
          ? 'Se pidió el alta de la credencial en el broker.'
          : 'Se pidió la baja de la credencial en el broker.',
    };
  }

  /**
   * Espera a que el provisioner cierre una fila. Devuelve el estado final, o
   * `null` si venció el plazo.
   *
   * SONDEA en vez de escuchar un canal: un `LISTEN` ahorraría estos
   * milisegundos a cambio de una conexión dedicada viva para siempre, y las
   * altas de fábrica son de a una y a ritmo humano. Además sondear no puede
   * perderse un evento — el bug que ya costó el barrido de pendientes.
   *
   * Que venza NO significa que el provisioner no vaya a hacer el trabajo:
   * significa que la web dejó de esperarlo. Quien llame tiene que decidir qué
   * hacer con eso (en el alta atómica: borrar el equipo).
   */
  async esperar(
    queueId: number,
    timeoutMs: number,
  ): Promise<{ estado: ProvisioningEstado; detalle: string | null } | null> {
    const limite = Date.now() + timeoutMs;

    for (;;) {
      const filas: { estado: ProvisioningEstado; detalle: string | null }[] =
        await this.dataSource.query(
          `SELECT estado, detalle FROM gtd.provisioning_queue WHERE id = $1`,
          [queueId],
        );

      const fila = filas[0];
      // Sin fila no hay nada que esperar: alguien borró el equipo y la cola se
      // fue por CASCADE. Se trata como vencido, no como éxito.
      if (!fila) return null;
      if (fila.estado !== 'pending') return fila;

      if (Date.now() >= limite) return null;
      await new Promise((r) =>
        setTimeout(r, Math.min(SONDEO_MS, limite - Date.now())),
      );
    }
  }

  /**
   * La última operación de CADA equipo de la lista, en una sola consulta.
   *
   * Un listado no puede hacer N consultas, pero tampoco puede mentir: sin esto,
   * un equipo con la credencial en cola se ve idéntico a uno al que nunca se le
   * pidió nada, y la tabla de fábrica —que existe para responder "¿qué me falta
   * terminar?"— no sirve para eso.
   */
  async estadosDe(
    deviceIds: number[],
  ): Promise<Map<number, ProvisioningQueueView>> {
    if (deviceIds.length === 0) return new Map();

    const filas: (ColaRow & { device_id: number })[] =
      await this.dataSource.query(
        `SELECT DISTINCT ON (device_id)
                device_id, op, estado, detalle, created_at
           FROM gtd.provisioning_queue
          WHERE device_id = ANY($1)
          ORDER BY device_id, created_at DESC`,
        [deviceIds],
      );

    return new Map(
      filas.map((f) => [
        f.device_id,
        {
          op: f.op,
          estado: f.estado,
          detalle: f.detalle,
          createdAt: f.created_at.toISOString(),
        },
      ]),
    );
  }

  /** La última operación del equipo, para mostrarla en la ficha. */
  async estadoDe(deviceId: number): Promise<ProvisioningQueueView | null> {
    const filas: ColaRow[] = await this.dataSource.query(
      `SELECT op, estado, detalle, created_at
         FROM gtd.provisioning_queue
        WHERE device_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [deviceId],
    );

    const fila = filas[0];
    if (!fila) return null;
    return {
      op: fila.op,
      estado: fila.estado,
      detalle: fila.detalle,
      createdAt: fila.created_at.toISOString(),
    };
  }
}
