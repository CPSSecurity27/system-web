import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { DeviceStatus, DeviceType } from '../../common/enums';
import { Account } from '../../accounts/entities/account.entity';
import { Neighborhood } from '../../neighborhoods/entities/neighborhood.entity';
import { DeviceMaintenance } from './device-maintenance.entity';

/**
 * La alarma comunitaria. Infraestructura del BARRIO, no de la vivienda: un poste
 * con sirena en la vía pública, compartido por todos los vecinos.
 *
 * v2 — ciclo de vida completo con INVENTARIO (cadena de custodia de 3 niveles):
 *
 *   FÁBRICA CPS            STOCK DE ORGANIZACIÓN      EN SERVICIO
 *   status=INVENTORY   ->  status=INVENTORY       ->  neighborhood_id NOT NULL
 *   organization_id=NULL   organization_id=cliente    organization_id=NULL
 *
 * El equipo nace en CPS con serial + claim_code; el técnico (municipal o CPS)
 * lo instala y lo RECLAMA con ese código: queda vinculado a SU barrio. Así la
 * muni se autoinstala sin que CPS pierda el control del stock.
 *
 * Acá va SOLO configuración. El estado VIVO (online, last_heartbeat, disparada)
 * vive en device_state, que escribe ÚNICAMENTE el servicio de alarmas (programa
 * aparte que comparte esta base).
 */
@Entity('device')
@Index('idx_device_neighborhood', ['neighborhoodId'])
@Check(
  'chk_device_custody',
  "(status = 'INVENTORY' AND neighborhood_id IS NULL) OR (status <> 'INVENTORY' AND neighborhood_id IS NOT NULL)",
)
@Check(
  'chk_device_stock_owner',
  "status = 'INVENTORY' OR organization_id IS NULL",
)
export class Device {
  @PrimaryGeneratedColumn()
  id!: number;

  /** Etiqueta humana ("Esquina Norte"). Se pone al instalar; en stock puede faltar. */
  @Column({ type: 'text', nullable: true })
  name!: string | null;

  /**
   * Identidad física del equipo, UNIQUE, no se cambia jamás.
   * La identidad en el canal de tiempo real se DERIVA de acá.
   */
  @Column({ type: 'text', unique: true })
  serial!: string;

  @Column({
    type: 'enum',
    enum: DeviceType,
    enumName: 'device_type',
    default: DeviceType.ALARM_PANEL,
  })
  type!: DeviceType;

  @Column({
    type: 'enum',
    enum: DeviceStatus,
    enumName: 'device_status',
    default: DeviceStatus.INVENTORY,
  })
  status!: DeviceStatus;

  /** Código de reclamo: lo usa el técnico para vincular el equipo a su barrio. */
  @Column({ name: 'claim_code', type: 'text', nullable: true })
  claimCode!: string | null;

  @Column({ name: 'manufactured_at', type: 'timestamptz', nullable: true })
  manufacturedAt!: Date | null;

  @Column({ type: 'boolean', default: false })
  tested!: boolean;

  @Column({ type: 'text', nullable: true })
  imei!: string | null;

  @Column({ type: 'text', nullable: true })
  iccid!: string | null;

  @Column({ type: 'text', nullable: true })
  mac!: string | null;

  /** Dueño del stock mientras está en INVENTORY. NULL = fábrica CPS. */
  @Column({ name: 'organization_id', type: 'int', nullable: true })
  organizationId!: number | null;

  @ManyToOne(() => Account, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'device_organization_id_fkey',
  })
  organization!: Account | null;

  /** NULL solo en INVENTORY (lo garantiza el CHECK). */
  @Column({ name: 'neighborhood_id', type: 'int', nullable: true })
  neighborhoodId!: number | null;

  @ManyToOne(() => Neighborhood, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({
    name: 'neighborhood_id',
    foreignKeyConstraintName: 'device_neighborhood_id_fkey',
  })
  neighborhood!: Neighborhood | null;

  @Column({ type: 'double precision', nullable: true })
  latitude!: number | null;

  @Column({ type: 'double precision', nullable: true })
  longitude!: number | null;

  @Column({ name: 'installed_at', type: 'timestamptz', nullable: true })
  installedAt!: Date | null;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy!: number | null;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => DeviceMaintenance, (m) => m.device)
  maintenances!: DeviceMaintenance[];
}
