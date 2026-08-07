import {
  Check,
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
import { RemoteStatus } from '../../common/enums';
import { Account } from '../../accounts/entities/account.entity';
import { Device } from '../../devices/entities/device.entity';
import { Home } from '../../homes/entities/home.entity';
import { User } from '../../users/entities/user.entity';
import { RemoteCode } from './remote-code.entity';
import { RemoteModel } from './remote-model.entity';

/**
 * El control remoto. Cadena de custodia de 3 niveles (v2, igual que device):
 *
 *   FÁBRICA CPS -> STOCK DE ORGANIZACIÓN -> HOGAR (dueño)
 *   INVENTORY      INVENTORY + org_id       home_id NOT NULL
 *
 * Y dentro del hogar, DUEÑO != PORTADOR:
 *   home_id             -> la VIVIENDA es dueña del control.
 *   assignedToUserId    -> quién lo LLEVA ENCIMA hoy. NULL = "en el cajón de la
 *                          casa" (el inventario del hogar). Se reasigna libre.
 *
 * Si un familiar se muda, el control NO se pierde: sigue siendo del hogar.
 */
@Entity('remote')
@Index('idx_remote_home', ['homeId'])
@Index('idx_remote_assigned', ['assignedToUserId'])
@Index('idx_remote_device', ['deviceId'])
// UNA PERSONA, UN CONTROL (uq_remote_one_per_carrier, parcial sobre los vivos):
// la base del panel guarda un registro por DNI, así que un segundo control del
// mismo portador nunca podría cargarse. El índice real vive en la migración —
// TypeORM no sabe expresar índices únicos parciales.
@Check(
  'chk_remote_custody',
  "(status = 'INVENTORY' AND home_id IS NULL) OR (status <> 'INVENTORY' AND home_id IS NOT NULL)",
)
@Check(
  'chk_remote_stock_owner',
  "status = 'INVENTORY' OR organization_id IS NULL",
)
export class Remote {
  @PrimaryGeneratedColumn()
  id!: number;

  /**
   * El que lo identifica: `CR-000137`. Correlativo, se asigna al FABRICARLO.
   *
   * NULL solo en los controles anteriores a la fábrica, que no tienen forma de
   * conseguir uno. Todo control nuevo lo trae, junto con su modelo, porque el
   * alta pasa por `manufacture` y las dos cosas van en la misma transacción.
   */
  @Column({ type: 'text', nullable: true })
  serial!: string | null;

  /** Cuántos botones tiene, o sea cuántos códigos lleva. NULL con `serial` NULL. */
  @Column({ name: 'model_id', type: 'int', nullable: true })
  modelId!: number | null;

  @ManyToOne(() => RemoteModel, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({
    name: 'model_id',
    foreignKeyConstraintName: 'remote_model_id_fkey',
  })
  model!: RemoteModel | null;

  /**
   * Código de UN SOLO USO para que un cliente sume el control a su stock.
   *
   * Va impreso en la etiqueta. El serial no alcanzaría: está a la vista y viaja
   * en cada listado, así que cualquiera que lo vea podría reclamar el control.
   * Esto es el secreto que demuestra que lo tenés en la mano.
   *
   * Se regenera al restaurar desde la papelera: el anterior quedó impreso en una
   * etiqueta que puede andar dando vueltas.
   */
  @Column({ name: 'claim_code', type: 'text', nullable: true })
  claimCode!: string | null;

  @Column({ name: 'manufactured_at', type: 'timestamptz', nullable: true })
  manufacturedAt!: Date | null;

  @Column({ name: 'manufactured_by', type: 'int', nullable: true })
  manufacturedBy!: number | null;

  /**
   * El visto bueno de fábrica. Hasta que no está, el control NO entra al stock.
   *
   * Fabricar no es estar listo: entre las dos cosas hay un rato en la mesa
   * —grabar los códigos, pegar la etiqueta, probar que transmita— y durante ese
   * rato el control existe pero no puede salir. `status` no puede decir esto:
   * uno recién fabricado ya está en INVENTORY porque el CHECK de custodia lo
   * exige mientras no tenga vivienda.
   */
  @Column({ name: 'ready_at', type: 'timestamptz', nullable: true })
  readyAt!: Date | null;

  @Column({ name: 'ready_by', type: 'int', nullable: true })
  readyBy!: number | null;

  /**
   * Fuera de circulación. Sale de todas las listas pero sigue existiendo.
   *
   * NO es un `status` más: `LOST` y `REPLACED` describen qué le pasó al control
   * en la vida real, esto dice si alguien lo sacó del sistema. Un control puede
   * estar `LOST` y todavía no removido.
   *
   * **Removerlo no impide que abra la alarma**: los códigos viven en la EEPROM
   * de cada panel y la web todavía no los sincroniza. Hasta que exista ese
   * flujo, esto es un acto administrativo.
   */
  @Column({ name: 'removed_at', type: 'timestamptz', nullable: true })
  removedAt!: Date | null;

  @Column({ name: 'removed_by', type: 'int', nullable: true })
  removedBy!: number | null;

  /**
   * Etiqueta humana OPCIONAL: "llavero cocina".
   *
   * Dejó de ser obligatoria cuando apareció el serial: lo que identifica al
   * control es el serial, y el nombre es un apodo que le pone la familia. En la
   * fábrica obligaba a inventar un "Control (stock)" por cada uno.
   */
  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({
    type: 'enum',
    enum: RemoteStatus,
    enumName: 'remote_status',
    default: RemoteStatus.INVENTORY,
  })
  status!: RemoteStatus;

  /** Dueño del stock mientras está en INVENTORY. NULL = fábrica CPS. */
  @Column({ name: 'organization_id', type: 'int', nullable: true })
  organizationId!: number | null;

  @ManyToOne(() => Account, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'remote_organization_id_fkey',
  })
  organization!: Account | null;

  /** NULL solo en INVENTORY (lo garantiza el CHECK). */
  @Column({ name: 'home_id', type: 'int', nullable: true })
  homeId!: number | null;

  @ManyToOne(() => Home, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({
    name: 'home_id',
    foreignKeyConstraintName: 'remote_home_id_fkey',
  })
  home!: Home | null;

  /** El portador. NULL = en la casa, sin dueño asignado. */
  @Column({ name: 'assigned_to_user_id', type: 'int', nullable: true })
  assignedToUserId!: number | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'assigned_to_user_id',
    foreignKeyConstraintName: 'remote_assigned_to_user_id_fkey',
  })
  assignedToUser!: User | null;

  /** La alarma donde está grabado el código RF de este control. */
  @Column({ name: 'device_id', type: 'int', nullable: true })
  deviceId!: number | null;

  @ManyToOne(() => Device, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'device_id',
    foreignKeyConstraintName: 'remote_device_id_fkey',
  })
  device!: Device | null;

  /**
   * ── Lo que quedó cargado en la EEPROM de un panel ──────────────────
   *
   * No es un flag "sincronizado": es el ESTADO CARGADO, y "pendiente" se deduce
   * comparándolo con lo que debería estar (la alarma preferida del hogar, el DNI
   * del portador y el hash de sus códigos). Así cambiar el portador, editar un
   * código o devolver el control al stock lo desincronizan solos, sin que nadie
   * tenga que acordarse de bajar una bandera.
   *
   * Las cuatro viajan juntas: lo impone `chk_remote_sync_completa`.
   */
  @Column({ name: 'synced_device_id', type: 'int', nullable: true })
  syncedDeviceId!: number | null;

  @ManyToOne(() => Device, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'synced_device_id',
    foreignKeyConstraintName: 'remote_synced_device_id_fkey',
  })
  syncedDevice!: Device | null;

  /**
   * Con qué DNI se cargó. NO es redundante con el portador: al volver al stock
   * el control lo pierde, y la base del panel está indexada por DNI — sin esto
   * no sabríamos qué borrar.
   */
  @Column({ name: 'synced_dni', type: 'text', nullable: true })
  syncedDni!: string | null;

  /**
   * FNV-1a de los códigos cargados, con el MISMO algoritmo que `rf_client_hash`
   * en `task_mqtt.c`: permite comparar contra la auditoría del panel sin
   * descifrar ningún código.
   */
  @Column({ name: 'synced_hash', type: 'bigint', nullable: true })
  syncedHash!: string | null;

  @Column({ name: 'synced_at', type: 'timestamptz', nullable: true })
  syncedAt!: Date | null;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy!: number | null;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => RemoteCode, (code) => code.remote)
  codes!: RemoteCode[];
}
