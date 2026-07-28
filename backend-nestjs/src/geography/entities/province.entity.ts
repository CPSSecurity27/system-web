import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Department } from './department.entity';

/**
 * Geografía: read-only, se sincroniza desde la API de georef del gobierno.
 * No se administra desde el panel.
 */
@Entity('province')
export class Province {
  @PrimaryGeneratedColumn()
  id!: number;

  /**
   * Clave de reconciliación contra georef en cada sync: el id es nuestro, el
   * georef_id es de ellos. TEXT y no INT: los códigos llevan ceros a la
   * izquierda ("06", "06021") y un INT los destruye en silencio.
   */
  @Column({ name: 'georef_id', type: 'text', unique: true })
  georefId!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'double precision', nullable: true })
  latitude!: number | null;

  @Column({ type: 'double precision', nullable: true })
  longitude!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => Department, (department) => department.province)
  departments!: Department[];
}
