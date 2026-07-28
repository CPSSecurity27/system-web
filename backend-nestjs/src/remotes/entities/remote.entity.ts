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
import { RemoteStatus } from '../../common/enums';
import { Account } from '../../accounts/entities/account.entity';
import { Device } from '../../devices/entities/device.entity';
import { Home } from '../../homes/entities/home.entity';
import { User } from '../../users/entities/user.entity';
import { RemoteCode } from './remote-code.entity';

/**
 * El control remoto. Cadena de custodia de 3 niveles (v2, igual que device):
 *
 *   FÁBRICA CPS -> STOCK DE ORGANIZACIÓN -> HOGAR (dueño)
 *   INVENTORY      INVENTORY + org_id       home_id NOT NULL
 *
 * Y dentro del hogar, DUEÑO != PORTADOR:
 *   home_id             -> la VIVIENDA es dueña del control.
 *   assignedToUserId    -> quién lo LLEVA ENCIMA hoy. NULL = "en el cajón de la
 *                          casa" (el inventario del hogar). Se reasigna libre.
 *
 * Si un familiar se muda, el control NO se pierde: sigue siendo del hogar.
 */
@Entity('remote')
@Index('idx_remote_home', ['homeId'])
@Index('idx_remote_assigned', ['assignedToUserId'])
@Index('idx_remote_device', ['deviceId'])
@Check(
  'chk_remote_custody',
  "(status = 'INVENTORY' AND home_id IS NULL) OR (status <> 'INVENTORY' AND home_id IS NOT NULL)",
)
@Check(
  'chk_remote_stock_owner',
  "status = 'INVENTORY' OR organization_id IS NULL",
)
export class Remote {
  @PrimaryGeneratedColumn()
  id!: number;

  /** Etiqueta humana: "llavero cocina", "Control (stock)". */
  @Column({ type: 'text' })
  name!: string;

  @Column({
    type: 'enum',
    enum: RemoteStatus,
    enumName: 'remote_status',
    default: RemoteStatus.INVENTORY,
  })
  status!: RemoteStatus;

  /** Dueño del stock mientras está en INVENTORY. NULL = fábrica CPS. */
  @Column({ name: 'organization_id', type: 'int', nullable: true })
  organizationId!: number | null;

  @ManyToOne(() => Account, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'remote_organization_id_fkey',
  })
  organization!: Account | null;

  /** NULL solo en INVENTORY (lo garantiza el CHECK). */
  @Column({ name: 'home_id', type: 'int', nullable: true })
  homeId!: number | null;

  @ManyToOne(() => Home, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({
    name: 'home_id',
    foreignKeyConstraintName: 'remote_home_id_fkey',
  })
  home!: Home | null;

  /** El portador. NULL = en la casa, sin dueño asignado. */
  @Column({ name: 'assigned_to_user_id', type: 'int', nullable: true })
  assignedToUserId!: number | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'assigned_to_user_id',
    foreignKeyConstraintName: 'remote_assigned_to_user_id_fkey',
  })
  assignedToUser!: User | null;

  /** La alarma donde está grabado el código RF de este control. */
  @Column({ name: 'device_id', type: 'int', nullable: true })
  deviceId!: number | null;

  @ManyToOne(() => Device, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'device_id',
    foreignKeyConstraintName: 'remote_device_id_fkey',
  })
  device!: Device | null;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy!: number | null;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => RemoteCode, (code) => code.remote)
  codes!: RemoteCode[];
}
