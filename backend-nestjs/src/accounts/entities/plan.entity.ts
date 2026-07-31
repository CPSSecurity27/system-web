import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { OrgSubtype } from '../../common/enums';

/**
 * El catálogo comercial: qué cupos otorga cada plan que CPS vende.
 *
 * Es una PLANTILLA, no la fuente de verdad. Al crear una cuenta los cupos se
 * COPIAN a las columnas `max_*` del `account`, y desde ahí en más son de esa
 * cuenta: reconfigurar el plan no le cambia nada a quien ya lo compró.
 *
 * Por qué no un `plan_id` que se lea en vivo, que sería más "normalizado":
 * porque la regla 4 del dominio dice que los cupos SOLO los modifica CPS,
 * siempre con `audit_log` y con grandfathering. Un plan leído en vivo bajaría
 * el cupo de cien clientes de una, sin una sola fila de auditoría y sin
 * respetar lo ya existente — exactamente las tres cosas que la regla prohíbe.
 * Es la misma decisión que ya tomó `service_contract` al congelar el precio.
 */
@Entity('plan')
@Check(
  'chk_plan_community_single_neighborhood',
  "applies_to <> 'COMMUNITY' OR max_neighborhoods = 1",
)
@Check('chk_plan_code', "code ~ '^[A-Z0-9_]{2,32}$'")
export class Plan {
  @PrimaryGeneratedColumn()
  id!: number;

  /** Identificador estable para hablar del plan sin depender del nombre comercial. */
  @Column({ type: 'text', unique: true })
  code!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** Un plan municipal ofrecido a una comunitaria sería un error de venta silencioso. */
  @Column({
    name: 'applies_to',
    type: 'enum',
    enum: OrgSubtype,
    enumName: 'org_subtype',
  })
  appliesTo!: OrgSubtype;

  /**
   * Precio de LISTA. El que se cobra es el del `service_contract`, congelado
   * al firmar; este es el de la vidriera y puede cambiar cuando se quiera.
   */
  @Column({
    name: 'price_reference',
    type: 'numeric',
    precision: 12,
    scale: 2,
    nullable: true,
  })
  priceReference!: string | null;

  /** false = discontinuado: no se ofrece más, pero los que lo compraron siguen igual. */
  @Column({ type: 'boolean', default: true })
  active!: boolean;

  // --- Cupos de ORGANIZACIÓN que otorga -------------------------------------

  @Column({ name: 'max_neighborhoods', type: 'int' })
  maxNeighborhoods!: number;

  @Column({ name: 'max_admin_users', type: 'int' })
  maxAdminUsers!: number;

  /** 0 = la organización no tiene técnicos propios (el campo lo hace CPS). */
  @Column({ name: 'max_technician_users', type: 'int' })
  maxTechnicianUsers!: number;

  @Column({ name: 'max_monitor_users', type: 'int' })
  maxMonitorUsers!: number;

  // --- Cupos de BARRIO que sugiere ------------------------------------------

  @Column({ name: 'max_family_members', type: 'int', default: 3 })
  maxFamilyMembers!: number;

  @Column({ name: 'remote_controls_enabled', type: 'boolean', default: true })
  remoteControlsEnabled!: boolean;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy!: number | null;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
