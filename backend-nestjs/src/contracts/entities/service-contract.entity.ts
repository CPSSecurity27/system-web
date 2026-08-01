import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AccountType, ContractStatus } from '../../common/enums';

/**
 * El contrato de servicio (v2.3): SIEMPRE organización -> CUENTA.
 *
 * Era del BARRIO hasta 2026-07-31. Se movió a la cuenta porque el sistema se
 * vende A NIVEL MUNICIPAL: la muni paga por una cantidad de barrios
 * (`account.max_neighborhoods`) y NO le revende a cada uno. Un contrato por
 * barrio la convertiría en intermediaria de sus propios vecinos.
 * Consecuencia: no existe un "barrio sin contrato" — si la cuenta tiene
 * contrato vigente, todos sus barrios están cubiertos hasta el cupo.
 *
 * Guarda lo comercial PURO y lo congela al firmar (price, fechas), como el
 * precio en una factura. Los CUPOS no viven acá: son columnas del barrio y de
 * la cuenta, editables solo por CPS (la parte flexible de la tarifa).
 *
 * El PERÍODO no se guarda: se deriva de start_date..end_date. Guardarlo sería
 * un segundo lugar donde vive el mismo dato, libre de contradecir a las fechas
 * (mismo criterio que los hitos de puesta en marcha del equipo).
 *
 * Invariantes que impone la BASE:
 *  - account_type es copia atada con FK compuesta a account(id, type) y fijada
 *    en 'ORGANIZATION' por CHECK: una COMPANY no puede contratar.
 *  - Índice único parcial: UN solo contrato ACTIVE por CUENTA.
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

  /**
   * OBLIGATORIA desde 2026-07-31: el precio es por EL PERÍODO del contrato, así
   * que sin fecha de fin el número no significa nada. Un contrato "abierto" se
   * modela firmando el siguiente cuando este vence (estado EXPIRED).
   */
  @Column({ name: 'end_date', type: 'date' })
  endDate!: string;

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

  // A propósito NO hay @ManyToOne a Account: en la base, account_id no tiene una
  // FK simple, sino la COMPUESTA (account_id, account_type) -> account(id, type).
  // TypeORM no sabe expresar eso; la cuenta se carga explícita cuando hace falta.

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy!: number | null;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
