import {
  ConflictException,
  Inject,
  Injectable,
  forwardRef,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AccessScope, ScopeService } from '../common/scope.service';
import { DevicesService } from './devices.service';

export type ProvisioningOp = 'provision' | 'revoke';
export type ProvisioningEstado = 'pending' | 'done' | 'failed';

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
