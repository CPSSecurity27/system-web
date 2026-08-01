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
import {
  AccountType,
  EntityStatus,
  JurisdictionLevel,
  OrgSubtype,
} from '../../common/enums';
import { Department } from '../../geography/entities/department.entity';
import { Locality } from '../../geography/entities/locality.entity';
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
@Check(
  'chk_account_jurisdiction',
  "(type = 'COMPANY' AND jurisdiction_level IS NULL AND locality_id IS NULL " +
    'AND department_id IS NULL) OR ' +
    "(type = 'ORGANIZATION' AND ((jurisdiction_level = 'LOCALITY' " +
    'AND locality_id IS NOT NULL AND department_id IS NULL) OR ' +
    "(jurisdiction_level = 'DEPARTMENT' AND department_id IS NOT NULL " +
    'AND locality_id IS NULL)))',
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

  /**
   * JURISDICCIÓN — hasta dónde llega el cliente. Es lo que se le VENDIÓ, y de
   * eso depende dónde puede crear barrios (lo valida NeighborhoodsService, no
   * la base: cruza neighborhood -> locality -> department contra account).
   *
   * NULL solo en COMPANY: CPS presta el servicio, no tiene territorio.
   */
  @Column({
    name: 'jurisdiction_level',
    type: 'enum',
    enum: JurisdictionLevel,
    enumName: 'jurisdiction_level',
    nullable: true,
  })
  jurisdictionLevel!: JurisdictionLevel | null;

  /** Con nivel LOCALITY: la localidad del cliente. Con DEPARTMENT: NULL. */
  @Column({ name: 'locality_id', type: 'int', nullable: true })
  localityId!: number | null;

  @ManyToOne(() => Locality, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'locality_id' })
  locality!: Locality | null;

  /** Con nivel DEPARTMENT: el departamento del cliente. Con LOCALITY: NULL. */
  @Column({ name: 'department_id', type: 'int', nullable: true })
  departmentId!: number | null;

  @ManyToOne(() => Department, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'department_id' })
  department!: Department | null;

  /** Domicilio en el mapa. Opcional: ubica al cliente, no valida nada. */
  @Column({ type: 'double precision', nullable: true })
  latitude!: number | null;

  @Column({ type: 'double precision', nullable: true })
  longitude!: number | null;

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
