import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { EntityStatus, UserKind } from '../../common/enums';
import { AccountUser } from '../../accounts/entities/account-user.entity';

/**
 * La tabla se llama `app_user`, no `user`: `user` es palabra reservada en
 * PostgreSQL (`SELECT user` devuelve el usuario de la sesión). En el código
 * TypeScript la clase se llama User igual.
 *
 * Una sola tabla de personas con DOS superficies de acceso:
 *  - panel web  -> account_user (membresías con rol)
 *  - app vecinos-> home_member (titular / familiar)
 *
 * kind = INSTITUTIONAL es el usuario "cuenta root" (ej. muni_sanpedro): sin
 * datos personales, solo puede ser OWNER, sobrevive a la rotación de empleados.
 */
@Entity('app_user')
@Check('chk_user_login_identity', 'username IS NOT NULL OR dni IS NOT NULL')
@Check('chk_institutional_no_dni', "kind <> 'INSTITUTIONAL' OR dni IS NULL")
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({
    type: 'enum',
    enum: UserKind,
    enumName: 'user_kind',
    default: UserKind.PERSON,
  })
  kind!: UserKind;

  @Column({ type: 'text' })
  name!: string;

  /** Handle de login del panel. NULL para vecinos (entran por email o DNI). */
  @Column({ type: 'text', unique: true, nullable: true })
  username!: string | null;

  /** Dato del vecino (opcional); también sirve como identidad alternativa de login. */
  @Column({ type: 'text', unique: true, nullable: true })
  dni!: string | null;

  /**
   * Identidad de login del vecino (obligatoria al crearlo desde v2.1: SMS y
   * WhatsApp salían caros y no había proveedor contratado). El vecino activa
   * su cuenta con un mail (fija contraseña + verifica el correo en un paso,
   * ver auth.service#resetPassword) y desde ahí entra con email o DNI.
   */
  @Column({ type: 'text', unique: true, nullable: true })
  email!: string | null;

  @Column({ type: 'text', nullable: true })
  telephone!: string | null;

  /**
   * Hash argon2id. La base NUNCA ve la contraseña en claro.
   * NULL para vecinos que entran solo con DNI + OTP.
   * `select: false` para que no salga en un find() por descuido.
   */
  @Column({
    name: 'password_hash',
    type: 'text',
    select: false,
    nullable: true,
  })
  passwordHash!: string | null;

  @Column({ type: 'enum', enum: EntityStatus, enumName: 'entity_status' })
  status!: EntityStatus;

  /**
   * NULL = correo sin verificar. Fecha en vez de booleano: dice "sí" y también
   * "desde cuándo". No bloquea el login (ver docs/auth.md).
   */
  @Column({ name: 'email_verified_at', type: 'timestamptz', nullable: true })
  emailVerifiedAt!: Date | null;

  /** NULL = teléfono sin verificar. Necesario antes del primer login por OTP. */
  @Column({ name: 'phone_verified_at', type: 'timestamptz', nullable: true })
  phoneVerifiedAt!: Date | null;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt!: Date | null;

  /**
   * Clave TEMPORAL sin cambiar (hoy solo se usa para INSTITUTIONAL, ver
   * UsersService#create): el `MustChangePasswordGuard` global bloquea todo
   * menos cambiar la contraseña mientras esto sea true.
   */
  @Column({ name: 'must_change_password', type: 'boolean', default: false })
  mustChangePassword!: boolean;

  // Auditoría nullable: el primer usuario del sistema no tiene creador.
  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy!: number | null;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => AccountUser, (membership) => membership.user)
  memberships!: AccountUser[];

  get emailVerified(): boolean {
    return this.emailVerifiedAt !== null;
  }
}
