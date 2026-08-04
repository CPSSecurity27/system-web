import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { AccountType, EntityStatus, ManagedBy } from '../../common/enums';
import { Account } from '../../accounts/entities/account.entity';
import { Locality } from '../../geography/entities/locality.entity';
import { Home } from '../../homes/entities/home.entity';

/**
 * El barrio: la unidad operativa. Pertenece a una localidad, tiene muchas
 * viviendas y muchos dispositivos.
 *
 * OJO: las alarmas (device) son infraestructura DEL BARRIO, no de la vivienda.
 * Postes y sirenas en la vía pública, compartidos por todos los vecinos.
 *
 * v2 — el molde único de las dos líneas de negocio:
 *  - organization_id: la organización CLIENTE (muni o consorcio), NOT NULL.
 *    La columna organization_type es redundancia CONTROLADA POR LA BASE (fijada
 *    en 'ORGANIZATION' por CHECK + FK compuesta): una COMPANY no puede ser
 *    dueña de barrios.
 *  - managed_by: quién lo OPERA. CPS = esquema privado; ORGANIZATION = la muni
 *    se autogestiona. Transferir la comunidad = cambiar organization_id y/o
 *    managed_by (solo CPS, siempre auditado). Nada más se toca.
 *  - Los CUPOS del barrio (max_family_members, remote_controls_enabled) son
 *    tarifa: SOLO CPS los escribe.
 */
@Entity('neighborhood')
@Index('idx_neighborhood_locality', ['localityId'])
@Index('idx_neighborhood_org', ['organizationId'])
@Unique('uq_neighborhood_id_org', ['id', 'organizationId'])
@Check('chk_neighborhood_org_type', "organization_type = 'ORGANIZATION'")
export class Neighborhood {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text' })
  name!: string;

  /**
   * Código corto que viaja al equipo como `central.grupo`. El firmware lo trunca
   * en 15 caracteres, así que "Barrio Parque Los Aromos" no entra: el nombre
   * largo se queda en la web y esto es lo que ve el panel.
   */
  @Column({ type: 'text' })
  code!: string;

  @Column({ type: 'enum', enum: EntityStatus, enumName: 'entity_status' })
  status!: EntityStatus;

  @Column({ name: 'organization_id', type: 'int' })
  organizationId!: number;

  /** Copia fijada por CHECK y verificada por la FK compuesta. No se escribe a mano. */
  @Column({
    name: 'organization_type',
    type: 'enum',
    enum: AccountType,
    enumName: 'account_type',
    default: AccountType.ORGANIZATION,
  })
  organizationType!: AccountType;

  @Column({
    name: 'managed_by',
    type: 'enum',
    enum: ManagedBy,
    enumName: 'managed_by_type',
  })
  managedBy!: ManagedBy;

  /** CUPO (solo CPS): familiares por hogar. Se impone al crear + grandfathering. */
  @Column({ name: 'max_family_members', type: 'int', default: 3 })
  maxFamilyMembers!: number;

  /**
   * ACTIVACIÓN COMUNITARIA (cupo, solo CPS): el permiso del vecino para salirse
   * de la alarma preferida de su hogar. Cubre las DOS formas de hacerlo:
   * disparar TODAS las del barrio a la vez (`scope = COMMUNITY`) o elegir UNA
   * distinta de la suya. Apagado, solo puede disparar la de su vivienda.
   *
   * Es UN permiso y no dos (2026-08-03): partirlo habilitaba la combinación
   * incoherente "no puede elegir una alarma lejana, pero sí dispararla junto
   * con todas las demás". Era `plan.community_mode_enabled` en el modelo viejo.
   */
  @Column({ name: 'community_scope_enabled', type: 'boolean', default: true })
  communityScopeEnabled!: boolean;

  /**
   * Dónde está el barrio. OBLIGATORIA desde `MandatoryCoordinates`: el barrio
   * sale en el tablero de clientes y en el mapa del monitoreo, y un punto
   * opcional deja el mapa a medias. No es un cupo: la carga cualquier gestor
   * del barrio, sin `audit_log`.
   */
  @Column({ type: 'double precision' })
  latitude!: number;

  @Column({ type: 'double precision' })
  longitude!: number;

  @Column({ name: 'locality_id', type: 'int' })
  localityId!: number;

  @ManyToOne(() => Locality, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'locality_id',
    foreignKeyConstraintName: 'neighborhood_locality_id_fkey',
  })
  locality!: Locality;

  // La FK real es la COMPUESTA (organization_id, organization_type) ->
  // account(id, type); se declara en la migración. La relación simple de acá es
  // solo para poder cargar la cuenta cliente en las consultas.
  @ManyToOne(() => Account, {
    onDelete: 'RESTRICT',
    createForeignKeyConstraints: false,
  })
  @JoinColumn({ name: 'organization_id' })
  organization!: Account;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy!: number | null;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => Home, (home) => home.neighborhood)
  homes!: Home[];
}
