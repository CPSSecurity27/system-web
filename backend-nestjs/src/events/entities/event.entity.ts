import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import {
  EventOrigin,
  EventScope,
  EventStatus,
  LocationMode,
} from '../../common/enums';
import { Device } from '../../devices/entities/device.entity';
import { Home } from '../../homes/entities/home.entity';
import { Neighborhood } from '../../neighborhoods/entities/neighborhood.entity';
import { Remote } from '../../remotes/entities/remote.entity';
import { User } from '../../users/entities/user.entity';
import { EventResponse } from './event-response.entity';

/**
 * El evento: una activación de alarma. El corazón operativo del negocio.
 *
 * APPEND-ONLY e ILIMITADO (un sistema de seguridad jamás rechaza una activación
 * por tarifa). Sin updated_at a propósito: la única mutación permitida es la
 * resolución (status + resolved_*), y la hace SOLO la web (el MONITOR). El
 * servicio de alarmas únicamente INSERTA — GRANTs de PostgreSQL lo refuerzan.
 *
 * activator_name / activator_phone van DENORMALIZADOS a propósito: son un
 * snapshot congelado. Si el vecino cambia de teléfono, el evento de hace seis
 * meses debe seguir mostrando el que era válido entonces (mismo criterio que el
 * precio congelado del contrato). Copiar para congelar historia es correcto.
 *
 * FKs RESTRICT: no se puede borrar un barrio/hogar/equipo con eventos. La
 * historia se protege sola.
 */
@Entity('event')
@Index('idx_event_neighborhood', ['neighborhoodId', 'createdAt'])
@Index('idx_event_device', ['deviceId'])
export class Event {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'neighborhood_id', type: 'int' })
  neighborhoodId!: number;

  @ManyToOne(() => Neighborhood, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'neighborhood_id',
    foreignKeyConstraintName: 'event_neighborhood_id_fkey',
  })
  neighborhood!: Neighborhood;

  @Column({ name: 'device_id', type: 'int', nullable: true })
  deviceId!: number | null;

  @ManyToOne(() => Device, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({
    name: 'device_id',
    foreignKeyConstraintName: 'event_device_id_fkey',
  })
  device!: Device | null;

  @Column({ name: 'home_id', type: 'int', nullable: true })
  homeId!: number | null;

  @ManyToOne(() => Home, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({
    name: 'home_id',
    foreignKeyConstraintName: 'event_home_id_fkey',
  })
  home!: Home | null;

  @Column({ name: 'remote_id', type: 'int', nullable: true })
  remoteId!: number | null;

  @ManyToOne(() => Remote, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({
    name: 'remote_id',
    foreignKeyConstraintName: 'event_remote_id_fkey',
  })
  remote!: Remote | null;

  @Column({ type: 'enum', enum: EventOrigin, enumName: 'event_origin' })
  origin!: EventOrigin;

  /** Descriptivo: registra qué tipo de activación fue. Sin cupo, sin permiso. */
  @Column({
    type: 'enum',
    enum: EventScope,
    enumName: 'event_scope',
    default: EventScope.SINGLE,
  })
  scope!: EventScope;

  /** Catálogo del hardware: cps001, cps002... */
  @Column({ name: 'trigger_mode', type: 'text', nullable: true })
  triggerMode!: string | null;

  @Column({ name: 'gps_lat', type: 'double precision', nullable: true })
  gpsLat!: number | null;

  @Column({ name: 'gps_lng', type: 'double precision', nullable: true })
  gpsLng!: number | null;

  @Column({
    name: 'location_mode',
    type: 'enum',
    enum: LocationMode,
    enumName: 'location_mode',
    nullable: true,
  })
  locationMode!: LocationMode | null;

  @Column({ name: 'activator_user_id', type: 'int', nullable: true })
  activatorUserId!: number | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'activator_user_id',
    foreignKeyConstraintName: 'event_activator_user_id_fkey',
  })
  activatorUser!: User | null;

  /** SNAPSHOT congelado al momento del evento. No se actualiza jamás. */
  @Column({ name: 'activator_name', type: 'text', nullable: true })
  activatorName!: string | null;

  @Column({ name: 'activator_phone', type: 'text', nullable: true })
  activatorPhone!: string | null;

  @Column({
    type: 'enum',
    enum: EventStatus,
    enumName: 'event_status',
    default: EventStatus.OPEN,
  })
  status!: EventStatus;

  @Column({ name: 'resolved_by_user_id', type: 'int', nullable: true })
  resolvedByUserId!: number | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'resolved_by_user_id',
    foreignKeyConstraintName: 'event_resolved_by_user_id_fkey',
  })
  resolvedByUser!: User | null;

  /** Snapshot del resolutor, mismo criterio que el activador. */
  @Column({ name: 'resolver_name', type: 'text', nullable: true })
  resolverName!: string | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @OneToMany(() => EventResponse, (response) => response.event)
  responses!: EventResponse[];
}
