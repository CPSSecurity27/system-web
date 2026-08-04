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

  /**
   * Catálogo del firmware:
   * off | suspicious | alert | emergency | fire | medical | silent | panic
   *
   * (El viejo 'connected'/'trigger' era de Firebase y nunca se escribió.)
   */
  @Column({ name: 'alarm_status', type: 'text', nullable: true })
  alarmStatus!: string | null;

  /** ACTIVE_240, MODEM_SLEEP, … */
  @Column({ name: 'power_mode', type: 'text', nullable: true })
  powerMode!: string | null;

  /**
   * Versión de configuración que el panel DICE estar corriendo. Vuelve a 0 tras
   * un `factory`: eso deja la `gtd.panel_config` en `stale` y obliga a
   * republicarla completa.
   */
  @Column({ name: 'cfg_v', type: 'bigint', default: 0 })
  cfgV!: string;

  /** Generación de la base RF cargada en el equipo (el `cfg_v` de los códigos). */
  @Column({ name: 'rf_gen', type: 'bigint', default: 0 })
  rfGen!: string;

  /** Versión de firmware. Llega por el `cfg_full`, no por el estado. */
  @Column({ type: 'text', nullable: true })
  fw!: string | null;

  /**
   * Voltajes, en columnas y no en un JSONB: es el dato de mantenimiento más
   * importante de un poste y hay que poder preguntar "¿cuáles están por debajo
   * de 11 V?" sin abrir un documento por fila.
   */
  @Column({ type: 'numeric', precision: 5, scale: 2, nullable: true })
  vbat!: string | null;

  @Column({ type: 'numeric', precision: 5, scale: 2, nullable: true })
  vpanel!: string | null;

  @Column({ type: 'numeric', precision: 5, scale: 2, nullable: true })
  vfuente!: string | null;

  /**
   * Cuándo habló por última vez. Lo pone el SERVIDOR (now() en
   * gtd.upsert_panel_state), no el reloj del panel: con tsq>=2 ese reloj puede
   * estar días atrás. Lo escribe CUALQUIER mensaje, no solo el latido.
   */
  @Column({ name: 'last_seen', type: 'timestamptz', nullable: true })
  lastSeen!: Date | null;

  @Column({ name: 'last_heartbeat', type: 'timestamptz', nullable: true })
  lastHeartbeat!: Date | null;

  /**
   * Hasta cuándo avisó que duerme. NULL = no está durmiendo. Un panel dormido
   * figura online=false: esta columna distingue "duerme hasta las 7" de
   * "se cayó a las 3 AM" — la diferencia entre despertar a un técnico y no.
   */
  @Column({ name: 'sleep_until', type: 'timestamptz', nullable: true })
  sleepUntil!: Date | null;

  /** El reloj que el panel DECLARA. Con tsq>=2 puede estar días atrás. */
  @Column({ name: 'ts_device', type: 'timestamptz', nullable: true })
  tsDevice!: Date | null;

  /** Calidad de ese reloj, 0..4, MENOR ES MEJOR (0=NTP, 4=sin sync). */
  @Column({ type: 'smallint', nullable: true })
  tsq!: number | null;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}
