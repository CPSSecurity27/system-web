import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Event } from './event.entity';

/** Vecinos que respondieron a un evento ("estoy yendo", "todo en orden"). */
@Entity('event_response')
@Unique('uq_event_response', ['eventId', 'userId'])
export class EventResponse {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'event_id', type: 'bigint' })
  eventId!: string;

  @ManyToOne(() => Event, (event) => event.responses, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'event_id',
    foreignKeyConstraintName: 'event_response_event_id_fkey',
  })
  event!: Event;

  @Column({ name: 'user_id', type: 'int' })
  userId!: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'event_response_user_id_fkey',
  })
  user!: User;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
