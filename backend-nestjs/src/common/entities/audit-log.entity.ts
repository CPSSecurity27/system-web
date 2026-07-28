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
 * Bitácora de auditoría. APPEND-ONLY: sin UPDATE ni DELETE para ningún rol de
 * conexión (GRANTs de PostgreSQL, ver §13 del esquema).
 *
 * Acciones que SIEMPRE auditan: reveal de códigos RF, transferencias de
 * comunidad, contratos, cambios de CUPOS (valor viejo -> nuevo), roles y
 * membresías, suspensiones, claim de equipos, credenciales y logins del OWNER.
 *
 * entity_type/entity_id son polimórficos SIN FK a propósito: la auditoría debe
 * sobrevivir a la entidad que describe (si un día se borra un control, su
 * historial de reveals no puede desaparecer con él).
 */
@Entity('audit_log')
@Index('idx_audit_entity', ['entityType', 'entityId'])
@Index('idx_audit_actor', ['actorUserId', 'createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'actor_user_id', type: 'int', nullable: true })
  actorUserId!: number | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'actor_user_id',
    foreignKeyConstraintName: 'audit_log_actor_user_id_fkey',
  })
  actorUser!: User | null;

  /** 'quota.update', 'contract.sign', 'neighborhood.transfer', 'remote_code.reveal'... */
  @Column({ type: 'text' })
  action!: string;

  @Column({ name: 'entity_type', type: 'text' })
  entityType!: string;

  @Column({ name: 'entity_id', type: 'bigint', nullable: true })
  entityId!: string | null;

  /** Contexto, sin FK (histórico polimórfico). */
  @Column({ name: 'account_id', type: 'int', nullable: true })
  accountId!: number | null;

  @Column({ name: 'neighborhood_id', type: 'int', nullable: true })
  neighborhoodId!: number | null;

  @Column({ name: 'old_value', type: 'jsonb', nullable: true })
  oldValue!: Record<string, unknown> | null;

  @Column({ name: 'new_value', type: 'jsonb', nullable: true })
  newValue!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @Column({ name: 'ip_address', type: 'text', nullable: true })
  ipAddress!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
