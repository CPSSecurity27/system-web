import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * Un JWT stateless NO se puede revocar. Sin esta tabla, echar a un técnico no
 * invalida su sesión hasta que el token expire solo: inaceptable en un sistema
 * de alarmas.
 *
 * Patrón: access token corto (stateless) + refresh token largo, guardado
 * HASHEADO (SHA-256) y revocable. El valor en claro solo lo tiene el cliente.
 */
@Entity('refresh_token')
@Index('idx_refresh_token_user', ['userId'])
export class RefreshToken {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'user_id', type: 'int' })
  userId!: number;

  @Column({ name: 'token_hash', type: 'text', unique: true })
  tokenHash!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  // Para poder auditar sesiones: desde dónde y con qué se conectó.
  @Column({ name: 'user_agent', type: 'text', nullable: true })
  userAgent!: string | null;

  @Column({ name: 'ip_address', type: 'inet', nullable: true })
  ipAddress!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'refresh_token_user_id_fkey',
  })
  user!: User;
}
