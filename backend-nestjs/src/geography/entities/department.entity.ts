import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Locality } from './locality.entity';
import { Province } from './province.entity';

// Índices y FK llevan el mismo nombre que en la migración: la entidad describe
// la tabla que ya existe, no una propia. Si no, migration:generate reporta un
// drift falso y quiere renombrarlos.
@Entity('department')
@Index('idx_department_province', ['provinceId'])
export class Department {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'georef_id', type: 'text', unique: true })
  georefId!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'double precision', nullable: true })
  latitude!: number | null;

  @Column({ type: 'double precision', nullable: true })
  longitude!: number | null;

  @Column({ name: 'province_id', type: 'int' })
  provinceId!: number;

  @ManyToOne(() => Province, (province) => province.departments, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'province_id',
    foreignKeyConstraintName: 'department_province_id_fkey',
  })
  province!: Province;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => Locality, (locality) => locality.department)
  localities!: Locality[];
}
