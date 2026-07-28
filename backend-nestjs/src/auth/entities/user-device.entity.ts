import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { UserDeviceStatus } from '../../common/enums';
import { User } from '../../users/entities/user.entity';

/**
 * El celular del vecino en la app. Regla del PDF que se conserva: UN solo
 * dispositivo ACTIVO por persona — la impone el índice único parcial
 * uq_user_device_active (migración). Registrar un teléfono nuevo revoca el
 * anterior y sus refresh tokens.
 *
 * fcm_token: adónde llegan las notificaciones push (FCM es infraestructura de
 * entrega, no base de datos — no contradice la eliminación de Firebase como
 * sistema de registro).
 */
@Entity('user_device')
@Index('idx_user_device_user', ['userId'])
export class UserDevice {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'user_id', type: 'int' })
  userId!: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'user_device_user_id_fkey',
  })
  user!: User;

  /** 'android' | 'ios' */
  @Column({ type: 'text', nullable: true })
  platform!: string | null;

  @Column({ name: 'device_fingerprint', type: 'text', nullable: true })
  deviceFingerprint!: string | null;

  @Column({ name: 'fcm_token', type: 'text', nullable: true })
  fcmToken!: string | null;

  @Column({
    type: 'enum',
    enum: UserDeviceStatus,
    enumName: 'user_device_status',
    default: UserDeviceStatus.ACTIVE,
  })
  status!: UserDeviceStatus;

  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
