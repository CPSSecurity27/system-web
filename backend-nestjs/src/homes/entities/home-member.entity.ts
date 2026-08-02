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
import { EntityStatus, HomeMemberRole } from '../../common/enums';
import { User } from '../../users/entities/user.entity';
import { Home } from './home.entity';

/**
 * El dominio del vecino (NUEVO en v2, reemplaza a las cuentas HOME).
 *
 * hogar + persona + rol (TITULAR | FAMILIAR). Es la puerta de la app de
 * vecinos: el acceso del vecino se deriva de acá, no de contratos.
 *
 * La relación NO vive en `home` ni en `app_user`: es esta fila. Ni
 * `home.members`, ni `user.home_id`, ni `home.owner_id` — los tres que tenía
 * Firebase, diciendo lo mismo en tres lugares que nada obligaba a mantener de
 * acuerdo.
 *
 * La base impone (migración):
 *  - UN TITULAR por hogar        (único parcial uq_home_single_titular)
 *  - UNA PERSONA VIVE EN UNA     (único TOTAL uq_home_member_one_home)
 *    SOLA CASA, sea titular o
 *    familiar
 *
 * Ese único total subsume al viejo uq_home_member (home_id, user_id) y al
 * parcial uq_user_single_titular, los dos eliminados en 2026-08-02. Sin él, un
 * vecino podía ser familiar en dos casas de dos barrios: el evento no sabría
 * qué barrio despertar y el cupo de familiares se esquivaba repartiendo gente.
 *
 * El servicio impone: FAMILIAR nunca supera neighborhood.max_family_members al
 * CREAR (si CPS baja el cupo: grandfathering, nadie se suspende). Un usuario
 * INSTITUTIONAL no puede ser miembro de un hogar.
 */
@Entity('home_member')
@Index('uq_home_member_one_home', ['userId'], { unique: true })
export class HomeMember {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'home_id', type: 'int' })
  homeId!: number;

  @Column({ name: 'user_id', type: 'int' })
  userId!: number;

  @Column({
    type: 'enum',
    enum: HomeMemberRole,
    enumName: 'home_member_role',
  })
  role!: HomeMemberRole;

  @Column({
    type: 'enum',
    enum: EntityStatus,
    enumName: 'entity_status',
    default: EntityStatus.ACTIVE,
  })
  status!: EntityStatus;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @ManyToOne(() => Home, (home) => home.members, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'home_id',
    foreignKeyConstraintName: 'home_member_home_id_fkey',
  })
  home!: Home;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'home_member_user_id_fkey',
  })
  user!: User;
}
