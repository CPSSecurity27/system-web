import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm';
import { Device } from './device.entity';

/**
 * Estado VIVO de la alarma: UNA fila por device, UPDATE in place, SIN historial
 * (el historial es event). Los heartbeats NUNCA insertan filas.
 *
 * La escribe ÚNICAMENTE el servicio de alarmas — el programa aparte que habla
 * MQTT con los equipos y comparte SOLO esta base con la web. La regla de un
 * solo escritor se refuerza con GRANTs de PostgreSQL (ver §13 del esquema):
 * el rol de conexión de la web no tiene INSERT/UPDATE sobre esta tabla.
 *
 * La web la LEE para el tablero de monitoreo (polling corto o LISTEN/NOTIFY).
 */
@Entity('device_state')
export class DeviceState {
  @PrimaryColumn({ name: 'device_id', type: 'int' })
  deviceId!: number;

  @OneToOne(() => Device, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'device_id',
    foreignKeyConstraintName: 'device_state_device_id_fkey',
  })
  device!: Device;

  @Column({ type: 'boolean', default: false })
  online!: boolean;

  /** Catálogo del hardware: 'connected' | 'trigger' | ... */
  @Column({ name: 'alarm_status', type: 'text', nullable: true })
  alarmStatus!: string | null;

  @Column({ name: 'last_heartbeat', type: 'timestamptz', nullable: true })
  lastHeartbeat!: Date | null;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
