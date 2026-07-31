import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Modelo de placa. Hoy hay uno solo: ALOY.
 *
 * El número de cada placa viene IMPRESO de fábrica como `<code><4 dígitos>`
 * (ALOY0043): el prefijo vive acá y el número, en `device.board_seq`. El string
 * completo NO se guarda en ningún lado — se compone, igual que
 * `device.serial = 'AV-' || mac`. Un solo lugar donde vive el dato, cero chance
 * de que el modelo y el número se contradigan.
 *
 * Es catálogo y no enum porque agregar un modelo tiene que ser un INSERT (o el
 * ABM de CPS), no una migración con deploy, y porque tarde o temprano hay que
 * colgarle atributos del hardware: hoy `remote_code` tiene clavado
 * `position BETWEEN 1 AND 4` con el comentario "el hardware tiene 4", y el día
 * que un modelo soporte 8 ese CHECK pasa a ser mentira.
 */
@Entity('board_model')
@Check('chk_board_model_code', "code ~ '^[A-Z]{2,8}$'")
export class BoardModel {
  @PrimaryGeneratedColumn()
  id!: number;

  /** Prefijo del número impreso ("ALOY"). Mayúsculas, sin dígitos. */
  @Column({ type: 'text', unique: true })
  code!: string;

  @Column({ type: 'text' })
  name!: string;

  /** Discontinuar un modelo NO toca los equipos ya fabricados con él. */
  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
