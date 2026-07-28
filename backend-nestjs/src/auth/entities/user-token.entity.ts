import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { UserTokenType } from '../../common/enums';
import { User } from '../../users/entities/user.entity';

/**
 * Token de un solo uso: verificación de email hoy, reseteo de contraseña
 * mañana. Mismo patrón que refresh_token: se guarda solo el HASH (SHA-256).
 * El valor en claro viaja en el link del mail y no queda en ningún lado.
 */
@Entity('user_token')
@Index('idx_user_token_user', ['userId', 'type'])
export class UserToken {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'user_id', type: 'int' })
  userId!: number;

  @Column({ type: 'enum', enum: UserTokenType, enumName: 'user_token_type' })
  type!: UserTokenType;

  @Column({ name: 'token_hash', type: 'text', unique: true })
  tokenHash!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  /** Marca el consumo. Un token usado no se puede volver a usar. */
  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'user_token_user_id_fkey',
  })
  user!: User;
}
