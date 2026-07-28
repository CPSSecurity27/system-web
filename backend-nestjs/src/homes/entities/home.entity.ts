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
import { EntityStatus } from '../../common/enums';
import { Device } from '../../devices/entities/device.entity';
import { Neighborhood } from '../../neighborhoods/entities/neighborhood.entity';
import { HomeMember } from './home-member.entity';

/**
 * La vivienda. Pertenece a un barrio. NO contrata nada (v2): el contrato es de
 * la organización sobre el barrio.
 *
 * NO tiene columna de titular, y es a propósito: el titular es la fila TITULAR
 * de home_member. Meter un `owner_id` acá sería una segunda fuente de verdad.
 *
 * v2 suma dos campos que el modelo viejo (Firebase) ya tenía:
 *  - contact_phone: teléfono DEL HOGAR (sobrevive a cambios de titular).
 *  - default_device_id: la alarma PREFERIDA para eventos SINGLE. Preferencia,
 *    no propiedad: debe ser del mismo barrio (regla de servicio); NULL = el
 *    sistema elige.
 */
@Entity('home')
@Index('idx_home_neighborhood', ['neighborhoodId'])
export class Home {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  address!: string | null;

  /** Teléfono del hogar, no del titular. */
  @Column({ name: 'contact_phone', type: 'text', nullable: true })
  contactPhone!: string | null;

  @Column({ type: 'enum', enum: EntityStatus, enumName: 'entity_status' })
  status!: EntityStatus;

  @Column({ type: 'double precision', nullable: true })
  latitude!: number | null;

  @Column({ type: 'double precision', nullable: true })
  longitude!: number | null;

  @Column({ name: 'neighborhood_id', type: 'int' })
  neighborhoodId!: number;

  @ManyToOne(() => Neighborhood, (neighborhood) => neighborhood.homes, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'neighborhood_id',
    foreignKeyConstraintName: 'home_neighborhood_id_fkey',
  })
  neighborhood!: Neighborhood;

  @Column({ name: 'default_device_id', type: 'int', nullable: true })
  defaultDeviceId!: number | null;

  @ManyToOne(() => Device, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'default_device_id',
    foreignKeyConstraintName: 'home_default_device_id_fkey',
  })
  defaultDevice!: Device | null;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy!: number | null;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => HomeMember, (member) => member.home)
  members!: HomeMember[];
}
