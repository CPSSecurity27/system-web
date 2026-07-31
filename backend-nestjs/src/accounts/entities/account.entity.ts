import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { AccountType, EntityStatus, OrgSubtype } from '../../common/enums';
import { AccountUser } from './account-user.entity';
import { Plan } from './plan.entity';

/**
 * Quien administra o contrata. Dos tipos:
 *   COMPANY      -> CPS Security. ÚNICA (índice único parcial). No contrata.
 *   ORGANIZATION -> el cliente: municipalidad (MUNICIPAL) o comunidad (COMMUNITY).
 *
 * Ya no existe el tipo HOME: los vecinos entran por home_member, no por cuentas.
 *
 * Los CUPOS son la parte flexible de la tarifa: SOLO CPS los modifica, todo
 * cambio queda en audit_log. Se imponen al CREAR; reducirlos aplica
 * grandfathering (nada se borra). En una ORGANIZATION son obligatorios — no
 * existe "sin límite" (2026-07-23) — y en COMPANY no aplican: NULL los cuatro.
 * El CHECK lo garantiza en las dos direcciones.
 *
 * Los tres cupos de PERSONAL usan el 0 con sentido: cupo 0 = ese rol no existe
 * en esta cuenta. Con eso, "una comunitaria no tiene técnicos propios" se dice
 * con el mismo mecanismo que "puede tener 5 monitores", en vez de con una
 * matriz de roles-por-tipo aparte que habría que mantener en paralelo.
 *
 * El UNIQUE (id, type) parece redundante porque id ya es PK, pero es lo que
 * habilita las FK compuestas de neighborhood y service_contract: sin él, esas
 * tablas no podrían atar "la cuenta Y su tipo" con una sola FK. No lo borres.
 */
@Entity('account')
@Unique('uq_account_id_type', ['id', 'type'])
@Check(
  'chk_subtype_by_type',
  "(type = 'ORGANIZATION' AND subtype IS NOT NULL " +
    'AND max_neighborhoods IS NOT NULL AND max_admin_users IS NOT NULL ' +
    'AND max_technician_users IS NOT NULL AND max_monitor_users IS NOT NULL) OR ' +
    "(type = 'COMPANY' AND subtype IS NULL AND plan_id IS NULL " +
    'AND max_neighborhoods IS NULL AND max_admin_users IS NULL ' +
    'AND max_technician_users IS NULL AND max_monitor_users IS NULL)',
)
export class Account {
  @PrimaryGeneratedColumn()
  id!: number;

  /** Sin UNIQUE global: dos consorcios homónimos en ciudades distintas es normal. */
  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'enum', enum: AccountType, enumName: 'account_type' })
  type!: AccountType;

  /**
   * Solo ORGANIZATION. La ESCALA del cliente (uno o varios barrios). QUIÉN
   * OPERA cada barrio NO se decide acá: eso es `neighborhood.managed_by`.
   */
  @Column({
    type: 'enum',
    enum: OrgSubtype,
    enumName: 'org_subtype',
    nullable: true,
  })
  subtype!: OrgSubtype | null;

  @Column({ type: 'enum', enum: EntityStatus, enumName: 'entity_status' })
  status!: EntityStatus;

  /**
   * De qué plan salieron los cupos al crear la cuenta. REFERENCIA HISTÓRICA:
   * sirve para "¿cuántos clientes hay en cada plan?" y nada más. Los cupos
   * vigentes son las columnas de abajo, nunca las del plan (ver Plan).
   */
  @Column({ name: 'plan_id', type: 'int', nullable: true })
  planId!: number | null;

  @ManyToOne(() => Plan, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'plan_id' })
  plan!: Plan | null;

  /** CUPO (solo CPS lo escribe): barrios que la organización puede crear. */
  @Column({ name: 'max_neighborhoods', type: 'int', nullable: true })
  maxNeighborhoods!: number | null;

  /** CUPO (solo CPS lo escribe): membresías ADMIN que puede tener. */
  @Column({ name: 'max_admin_users', type: 'int', nullable: true })
  maxAdminUsers!: number | null;

  /** CUPO (solo CPS lo escribe). 0 = sin técnicos propios: el campo lo hace CPS. */
  @Column({ name: 'max_technician_users', type: 'int', nullable: true })
  maxTechnicianUsers!: number | null;

  /** CUPO (solo CPS lo escribe): membresías MONITOR que puede tener. */
  @Column({ name: 'max_monitor_users', type: 'int', nullable: true })
  maxMonitorUsers!: number | null;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy!: number | null;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => AccountUser, (membership) => membership.account)
  memberships!: AccountUser[];
}
