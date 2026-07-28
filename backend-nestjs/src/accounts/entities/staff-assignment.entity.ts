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
import { Neighborhood } from '../../neighborhoods/entities/neighborhood.entity';
import { AccountUser } from './account-user.entity';

/**
 * Alcance por barrio para TECHNICIAN y MONITOR (el PDF: "personal asignado por
 * comunidad"). OWNER y ADMIN siempre ven toda su organización.
 *
 * Regla: SIN filas = el miembro ve TODOS los barrios de su organización (default
 * cómodo). CON filas = solo esos barrios.
 *
 * account_id está repetido a propósito: las DOS FK compuestas de la migración
 *   (account_user_id, account_id) -> account_user(id, account_id)
 *   (neighborhood_id, account_id) -> neighborhood(id, organization_id)
 * comparten esa columna, con lo cual asignarle a un miembro un barrio de OTRA
 * organización es imposible A NIVEL BASE. No es un chequeo: es la estructura.
 */
@Entity('staff_assignment')
@Unique('uq_staff_assignment', ['accountUserId', 'neighborhoodId'])
@Index('idx_sa_neighborhood', ['neighborhoodId'])
export class StaffAssignment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'account_user_id', type: 'int' })
  accountUserId!: number;

  @Column({ name: 'account_id', type: 'int' })
  accountId!: number;

  @Column({ name: 'neighborhood_id', type: 'int' })
  neighborhoodId!: number;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  // Las FK reales son las COMPUESTAS (migración). Estas relaciones simples son
  // solo para cargar datos en las consultas.
  @ManyToOne(() => AccountUser, {
    onDelete: 'CASCADE',
    createForeignKeyConstraints: false,
  })
  @JoinColumn({ name: 'account_user_id' })
  membership!: AccountUser;

  @ManyToOne(() => Neighborhood, {
    onDelete: 'CASCADE',
    createForeignKeyConstraints: false,
  })
  @JoinColumn({ name: 'neighborhood_id' })
  neighborhood!: Neighborhood;
}
