import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Department } from './department.entity';

@Entity('locality')
@Index('idx_locality_department', ['departmentId'])
export class Locality {
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

  @Column({ name: 'department_id', type: 'int' })
  departmentId!: number;

  @ManyToOne(() => Department, (department) => department.localities, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'department_id',
    foreignKeyConstraintName: 'locality_department_id_fkey',
  })
  department!: Department;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  // El barrio (neighborhood) cuelga de acá, pero esa entidad todavía no existe.
}
