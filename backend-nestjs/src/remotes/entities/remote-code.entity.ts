import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Remote } from './remote.entity';

/**
 * SENSIBLE. Son los códigos RF que ABREN LA ALARMA.
 *
 * - Se cifran en NestJS con AES-256-GCM ANTES de insertar: la base nunca los ve
 *   en claro. Si alguien se roba un dump, no se lleva códigos usables.
 * - `select: false`: no salen en un find() por descuido. Hay que pedirlos explícito.
 * - No se exponen en ningún endpoint que no sea de administración.
 *
 * El tope de 4 códigos por control (M2: el hardware tiene 4) lo impone el
 * ESQUEMA (UNIQUE (remote_id, position) con position BETWEEN 1 AND 4), no un if
 * en el servicio.
 */
@Entity('remote_code')
@Unique('uq_remote_code_position', ['remoteId', 'position'])
@Index('idx_remote_code_remote', ['remoteId'])
export class RemoteCode {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'remote_id', type: 'int' })
  remoteId!: number;

  @ManyToOne(() => Remote, (remote) => remote.codes, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'remote_id',
    foreignKeyConstraintName: 'remote_code_remote_id_fkey',
  })
  remote!: Remote;

  /** AES-256-GCM: iv (12 bytes) || authTag (16 bytes) || ciphertext. */
  @Column({ name: 'code_encrypted', type: 'bytea', select: false })
  codeEncrypted!: Buffer;

  /** 1..4. El CHECK de la base lo garantiza. */
  @Column({ type: 'smallint' })
  position!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
