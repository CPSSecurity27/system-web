import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Catálogo de modelos de control remoto. Mismo patrón que `board_model`.
 *
 * Lo que define un modelo es **cuántos botones tiene**, porque eso decide
 * cuántos códigos se cargan al fabricarlo.
 *
 * Hoy hay una sola fila, la de 4 botones, y es la única que el panel aprovecha
 * entera: el firmware guarda 4 códigos por vecino y la POSICIÓN decide qué hace
 * cada uno (1 emergencia, 2 sospechoso, 3 alerta, 4 apagar). Un modelo de 2
 * botones existe recién cuando se decida qué dos posiciones lleva —y esa
 * decisión define si el vecino puede apagar una falsa alarma—; uno de 6 tiene
 * dos botones que el panel no puede registrar.
 */
@Entity('remote_model')
@Check('chk_remote_model_buttons', 'buttons BETWEEN 1 AND 8')
export class RemoteModel {
  @PrimaryGeneratedColumn()
  id!: number;

  /** Corto y en mayúsculas: `CR4`. */
  @Column({ type: 'text', unique: true })
  code!: string;

  @Column({ type: 'text' })
  name!: string;

  /** Cuántos códigos se cargan al fabricar. El panel registra hasta 4. */
  @Column({ type: 'smallint' })
  buttons!: number;

  /** Un modelo no se borra: se discontinúa. */
  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
