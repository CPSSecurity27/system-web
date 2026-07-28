import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { UserRole } from '../../common/enums';
import { User } from '../../users/entities/user.entity';
import { Account } from './account.entity';

/**
 * Tabla puente: une una persona a UNA cuenta con un rol. Un técnico de CPS que
 * además es vecino es un solo app_user con una membresía acá y una fila en
 * home_member. No colapsar esto en un account_id dentro de app_user.
 *
 * v2: desapareció la copia de account_type — con el tipo HOME eliminado, los
 * cuatro roles valen en ambos tipos de cuenta y el CHECK de matriz quedó vacío.
 * El tipo se obtiene con un join a account cuando hace falta (buildAuthenticatedUser).
 *
 * v2.2 (migración SingleAccountMembership, 2026-07-24): una persona pertenece
 * a UNA sola cuenta a la vez — antes el UNIQUE era compuesto (account_id,
 * user_id) y permitía varias membresías por persona; se decidió que ese caso
 * ("operador compartido entre dos clientes") no se iba a dar en la práctica.
 *
 * Reglas que NO puede imponer la base (van en AccountsService):
 *  - el usuario con rol OWNER debe ser kind = INSTITUTIONAL, y viceversa
 *  - cupo max_monitor_users al crear una membresía MONITOR
 *
 * Reglas que SÍ impone la base (migración):
 *  - exactamente un OWNER por cuenta (índice único parcial uq_account_single_owner)
 *  - UNIQUE(user_id): a lo sumo una membresía por persona
 *  - UNIQUE (id, account_id): habilita la FK compuesta de staff_assignment
 */
@Entity('account_user')
@Unique('uq_account_user_single_account', ['userId'])
@Unique('uq_account_user_id_account', ['id', 'accountId'])
@Index('idx_account_user_account', ['accountId'])
export class AccountUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'account_id', type: 'int' })
  accountId!: number;

  @Column({ name: 'user_id', type: 'int' })
  userId!: number;

  @Column({ type: 'enum', enum: UserRole, enumName: 'user_role' })
  role!: UserRole;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => Account, (account) => account.memberships, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'account_id',
    foreignKeyConstraintName: 'account_user_account_id_fkey',
  })
  account!: Account;

  @ManyToOne(() => User, (user) => user.memberships, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'account_user_user_id_fkey',
  })
  user!: User;
}
