import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AccountType, ContractStatus } from '../../common/enums';
import { Neighborhood } from '../../neighborhoods/entities/neighborhood.entity';

/**
 * El contrato de servicio (v2): SIEMPRE organización -> barrio. Ya no existen
 * contratos por vivienda (nadie paga a nivel hogar en ningún esquema).
 *
 * Guarda lo comercial PURO y lo congela al firmar (price, fechas), como el
 * precio en una factura. Los CUPOS ya no viven acá: son columnas del barrio y
 * de la cuenta, editables solo por CPS (la parte flexible de la tarifa).
 *
 * El FK apunta del contrato hacia el barrio (y no al revés) para conservar el
 * historial: un barrio acumula contratos vencidos.
 *
 * Invariantes que impone la BASE:
 *  - account_type es copia atada con FK compuesta a account(id, type) y fijada
 *    en 'ORGANIZATION' por CHECK: una COMPANY no puede contratar.
 *  - Índice único parcial: UN solo contrato ACTIVE por barrio.
 */
@Entity('service_contract')
@Index('idx_contract_account', ['accountId'])
@Check('chk_contract_org_only', "account_type = 'ORGANIZATION'")
export class ServiceContract {
  @PrimaryGeneratedColumn()
  id!: number;

  /**
   * NUMERIC(12,2), nunca DOUBLE: punto flotante para dinero es un bug garantizado
   * (0.1 + 0.2 !== 0.3). El driver lo entrega como string para no perder
   * precisión, y el transformer lo pasa a number solo al leer.
   */
  @Column({
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: {
      to: (value: number) => value,
      from: (value: string | null) => (value === null ? null : Number(value)),
    },
  })
  price!: number;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'start_date', type: 'date' })
  startDate!: string;

  /** Nullable: un contrato abierto o autorrenovable no tiene fecha de fin. */
  @Column({ name: 'end_date', type: 'date', nullable: true })
  endDate!: string | null;

  @Column({ type: 'enum', enum: ContractStatus, enumName: 'contract_status' })
  status!: ContractStatus;

  @Column({ name: 'account_id', type: 'int' })
  accountId!: number;

  /** Copia fijada por CHECK y validada por la FK compuesta. No viene del cliente. */
  @Column({
    name: 'account_type',
    type: 'enum',
    enum: AccountType,
    enumName: 'account_type',
    default: AccountType.ORGANIZATION,
  })
  accountType!: AccountType;

  @Column({ name: 'neighborhood_id', type: 'int' })
  neighborhoodId!: number;

  // A propósito NO hay @ManyToOne a Account: en la base, account_id no tiene una
  // FK simple, sino la COMPUESTA (account_id, account_type) -> account(id, type).
  // TypeORM no sabe expresar eso; la cuenta se carga explícita cuando hace falta.

  @ManyToOne(() => Neighborhood, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'neighborhood_id',
    foreignKeyConstraintName: 'service_contract_neighborhood_id_fkey',
  })
  neighborhood!: Neighborhood;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy!: number | null;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
