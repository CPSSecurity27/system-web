import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
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
 * La base impone (migración):
 *  - UN TITULAR por hogar        (único parcial uq_home_single_titular)
 *  - una persona es titular de   (único parcial uq_user_single_titular)
 *    UN solo hogar
 *  - una persona no se repite en (UNIQUE compuesto uq_home_member)
 *    el mismo hogar
 *
 * El servicio impone: FAMILIAR nunca supera neighborhood.max_family_members al
 * CREAR (si CPS baja el cupo: grandfathering, nadie se suspende). Un usuario
 * INSTITUTIONAL no puede ser miembro de un hogar.
 */
@Entity('home_member')
@Unique('uq_home_member', ['homeId', 'userId'])
@Index('idx_home_member_user', ['userId'])
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
