import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { MaintenanceStatus, MaintenanceType } from '../../common/enums';
import { User } from '../../users/entities/user.entity';
import { Device } from './device.entity';

/** Bitácora del técnico sobre una alarma: instalación, service, reparación. */
@Entity('device_maintenance')
@Index('idx_maintenance_device', ['deviceId', 'createdAt'])
export class DeviceMaintenance {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'device_id', type: 'int' })
  deviceId!: number;

  @ManyToOne(() => Device, (device) => device.maintenances, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'device_id',
    foreignKeyConstraintName: 'device_maintenance_device_id_fkey',
  })
  device!: Device;

  @Column({ type: 'enum', enum: MaintenanceType, enumName: 'maintenance_type' })
  type!: MaintenanceType;

  @Column({
    type: 'enum',
    enum: MaintenanceStatus,
    enumName: 'maintenance_status',
  })
  status!: MaintenanceStatus;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'performed_at', type: 'timestamptz', nullable: true })
  performedAt!: Date | null;

  /** El técnico. Nullable: si se lo borra del sistema, la bitácora no se pierde. */
  @Column({ name: 'user_id', type: 'int', nullable: true })
  userId!: number | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'device_maintenance_user_id_fkey',
  })
  user!: User | null;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy!: number | null;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
