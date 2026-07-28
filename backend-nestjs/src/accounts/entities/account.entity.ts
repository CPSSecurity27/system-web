import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { AccountType, EntityStatus, OrgSubtype } from '../../common/enums';
import { AccountUser } from './account-user.entity';

/**
 * Quien administra o contrata. Dos tipos:
 *   COMPANY      -> CPS Security. ÚNICA (índice único parcial). No contrata.
 *   ORGANIZATION -> el cliente: municipalidad (MUNICIPAL) o consorcio (PRIVATE).
 *
 * Ya no existe el tipo HOME: los vecinos entran por home_member, no por cuentas.
 *
 * Los CUPOS (max_neighborhoods, max_monitor_users) son la parte flexible de la
 * tarifa: SOLO CPS los modifica, todo cambio queda en audit_log, NULL = sin
 * límite. Se imponen al CREAR; reducirlos aplica grandfathering (nada se borra).
 *
 * El UNIQUE (id, type) parece redundante porque id ya es PK, pero es lo que
 * habilita las FK compuestas de neighborhood y service_contract: sin él, esas
 * tablas no podrían atar "la cuenta Y su tipo" con una sola FK. No lo borres.
 */
@Entity('account')
@Unique('uq_account_id_type', ['id', 'type'])
@Check(
  'chk_subtype_by_type',
  "(type = 'ORGANIZATION' AND subtype IS NOT NULL) OR " +
    "(type = 'COMPANY' AND subtype IS NULL AND max_neighborhoods IS NULL AND max_monitor_users IS NULL)",
)
export class Account {
  @PrimaryGeneratedColumn()
  id!: number;

  /** Sin UNIQUE global: dos consorcios homónimos en ciudades distintas es normal. */
  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'enum', enum: AccountType, enumName: 'account_type' })
  type!: AccountType;

  /** Solo ORGANIZATION. Fija el default de neighborhood.managed_by. */
  @Column({
    type: 'enum',
    enum: OrgSubtype,
    enumName: 'org_subtype',
    nullable: true,
  })
  subtype!: OrgSubtype | null;

  @Column({ type: 'enum', enum: EntityStatus, enumName: 'entity_status' })
  status!: EntityStatus;

  /** CUPO (solo CPS lo escribe): barrios que la organización puede crear. */
  @Column({ name: 'max_neighborhoods', type: 'int', nullable: true })
  maxNeighborhoods!: number | null;

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
