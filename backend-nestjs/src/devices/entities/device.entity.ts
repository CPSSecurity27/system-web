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
import {
  DeviceMilestoneSource,
  DeviceStatus,
  DeviceType,
} from '../../common/enums';
import { Account } from '../../accounts/entities/account.entity';
import { Neighborhood } from '../../neighborhoods/entities/neighborhood.entity';
import { BoardModel } from './board-model.entity';
import { DeviceMaintenance } from './device-maintenance.entity';

/**
 * La alarma comunitaria. Infraestructura del BARRIO, no de la vivienda: un poste
 * con sirena en la vía pública, compartido por todos los vecinos.
 *
 * v2 — ciclo de vida completo con INVENTARIO (cadena de custodia de 3 niveles):
 *
 *   FÁBRICA CPS            STOCK DE ORGANIZACIÓN      EN SERVICIO
 *   status=INVENTORY   ->  status=INVENTORY       ->  neighborhood_id NOT NULL
 *   organization_id=NULL   organization_id=cliente    organization_id=NULL
 *
 * El equipo nace en CPS con serial + claim_code; el técnico (municipal o CPS)
 * lo instala y lo RECLAMA con ese código: queda vinculado a SU barrio. Así la
 * muni se autoinstala sin que CPS pierda el control del stock.
 *
 * Acá va SOLO configuración. El estado VIVO (online, last_heartbeat, disparada)
 * vive en device_state, que escribe ÚNICAMENTE el servicio de alarmas (programa
 * aparte que comparte esta base).
 */
@Entity('device')
@Index('idx_device_neighborhood', ['neighborhoodId'])
@Check(
  'chk_device_custody',
  "(status = 'INVENTORY' AND neighborhood_id IS NULL) OR (status <> 'INVENTORY' AND neighborhood_id IS NOT NULL)",
)
@Check(
  'chk_device_stock_owner',
  "status = 'INVENTORY' OR organization_id IS NULL",
)
@Check('chk_device_mac_format', "mac IS NULL OR mac ~ '^[0-9A-F]{12}$'")
@Check(
  'chk_device_board_seq',
  'board_seq IS NULL OR (board_seq BETWEEN 1 AND 9999)',
)
@Check(
  'chk_device_gps',
  "status = 'INVENTORY' OR (latitude IS NOT NULL AND longitude IS NOT NULL)",
)
@Check(
  'chk_device_removed_by',
  '(removed_at IS NULL AND removed_by IS NULL) OR (removed_at IS NOT NULL AND removed_by IS NOT NULL)',
)
@Check(
  'chk_device_tested_by',
  '(tested_at IS NULL AND tested_by IS NULL) OR (tested_at IS NOT NULL AND tested_by IS NOT NULL)',
)
@Check(
  'chk_device_ready_by',
  '(ready_at IS NULL AND ready_by IS NULL) OR (ready_at IS NOT NULL AND ready_by IS NOT NULL)',
)
@Check(
  'chk_device_portal_creds',
  '(portal_derived_at IS NULL AND portal_admin_enc IS NULL AND portal_cps_enc IS NULL) OR (portal_derived_at IS NOT NULL AND portal_admin_enc IS NOT NULL AND portal_cps_enc IS NOT NULL)',
)
@Check(
  'chk_device_first_connection',
  '(first_connection_at IS NULL AND first_connection_source IS NULL) OR (first_connection_at IS NOT NULL AND first_connection_source IS NOT NULL)',
)
@Check(
  'chk_device_first_connection_by',
  "first_connection_source IS DISTINCT FROM 'MANUAL' OR first_connection_by IS NOT NULL",
)
@Check(
  'chk_device_identity',
  "type <> 'COMMUNITY_ALARM' OR (mac IS NOT NULL AND serial = 'AV-' || mac AND board_model_id IS NOT NULL AND board_seq IS NOT NULL)",
)
export class Device {
  @PrimaryGeneratedColumn()
  id!: number;

  /** Etiqueta humana ("Esquina Norte"). Se pone al instalar; en stock puede faltar. */
  @Column({ type: 'text', nullable: true })
  name!: string | null;

  /**
   * Identidad física del equipo, UNIQUE, no se cambia jamás. En una alarma
   * comunitaria NO se elige: es `'AV-' || mac`, y el CHECK chk_device_identity
   * lo impone. Ese string ES el usuario MQTT y el `<id>` del tópico
   * (`av/AV-A842E38FCA6C/status`), o sea el JOIN con el servicio de alarmas.
   */
  @Column({ type: 'text', unique: true })
  serial!: string;

  @Column({
    type: 'enum',
    enum: DeviceType,
    enumName: 'device_type',
    default: DeviceType.COMMUNITY_ALARM,
  })
  type!: DeviceType;

  @Column({
    type: 'enum',
    enum: DeviceStatus,
    enumName: 'device_status',
    default: DeviceStatus.INVENTORY,
  })
  status!: DeviceStatus;

  /** Código de reclamo: lo usa el técnico para vincular el equipo a su barrio. */
  @Column({ name: 'claim_code', type: 'text', nullable: true })
  claimCode!: string | null;

  @Column({ name: 'manufactured_at', type: 'timestamptz', nullable: true })
  manufacturedAt!: Date | null;

  /**
   * Prueba funcional del equipo YA CONECTADO: sirena, RF, sensores.
   *
   * Fecha y no booleano (2026-08-05): un tilde no dice cuándo se probó ni quién
   * lo probó, y sin fecha no se puede ordenar contra los otros hitos. Reemplazó
   * al viejo `tested`, que además se marcaba en el alta —antes de que el equipo
   * se hubiera conectado a nada— y por eso mentía en la escalera.
   */
  @Column({ name: 'tested_at', type: 'timestamptz', nullable: true })
  testedAt!: Date | null;

  @Column({ name: 'tested_by', type: 'int', nullable: true })
  testedBy!: number | null;

  /**
   * Visto bueno para que el equipo salga de fábrica.
   *
   * NO se deriva de los otros hitos a propósito: que estén cumplidos no es lo
   * mismo que alguien se haga cargo de que el equipo puede despacharse.
   */
  @Column({ name: 'ready_at', type: 'timestamptz', nullable: true })
  readyAt!: Date | null;

  @Column({ name: 'ready_by', type: 'int', nullable: true })
  readyBy!: number | null;

  @Column({ type: 'text', nullable: true })
  imei!: string | null;

  @Column({ type: 'text', nullable: true })
  iccid!: string | null;

  /**
   * MAC STA del eFuse: 12 hex en MAYÚSCULAS y SIN separadores. Es el dato que
   * el operador lee con `esptool read_mac` en la estación de flasheo y la única
   * identidad realmente única e inmutable del equipo. Un solo formato canónico
   * o el UNIQUE no sirve de nada.
   */
  @Column({ type: 'text', nullable: true })
  mac!: string | null;

  /** Modelo de placa (catálogo). El prefijo del número impreso: ALOY. */
  @Column({ name: 'board_model_id', type: 'int', nullable: true })
  boardModelId!: number | null;

  @ManyToOne(() => BoardModel, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({
    name: 'board_model_id',
    foreignKeyConstraintName: 'device_board_model_id_fkey',
  })
  boardModel!: BoardModel | null;

  /**
   * El número impreso en la placa, sin el prefijo: 43 para "ALOY0043". Viene de
   * fábrica, no lo asigna CPS. El string completo se COMPONE (ver `boardNumber`
   * en el serializer); guardarlo aparte sería otra copia que puede divergir.
   */
  @Column({ name: 'board_seq', type: 'int', nullable: true })
  boardSeq!: number | null;

  /**
   * Cuándo se cargó la credencial MQTT de este equipo en el broker. NULL = está
   * dado de alta en el inventario pero TODAVÍA NO puede conectarse.
   *
   * Hoy nadie la escribe: la derivación HMAC está bloqueada por el `SALT_MQTT`
   * de producción, así que el alta solo muestra el comando pendiente. La columna
   * nace igual para no migrar filas después, y para poder preguntar en cualquier
   * momento qué equipos quedaron a medio provisionar.
   */
  @Column({ name: 'mqtt_provisioned_at', type: 'timestamptz', nullable: true })
  mqttProvisionedAt!: Date | null;

  @Column({ name: 'mqtt_provisioned_by', type: 'int', nullable: true })
  mqttProvisionedBy!: number | null;

  /**
   * Credenciales del PORTAL LOCAL del equipo (AP abierto, 192.168.4.1), que no
   * son las del broker: `djb2_xor(salt_del_rol, MAC SoftAP)` -> 6 hex.
   *
   * Las escribe SIEMPRE el provisioner vía `gtd.confirm_manufacture`, ya
   * cifradas (AES-256-GCM, base64 de `iv||tag||ct`). La web solo descifra: no
   * tiene los salts y no puede generar una. Guardarlas —aunque sean
   * recalculables— es lo que hace que reimprimir una etiqueta no dependa de que
   * el provisioner esté vivo.
   *
   * `admin` va impresa en la etiqueta; `cps` JAMÁS se imprime y se lee por un
   * endpoint aparte, con otro permiso y `audit_log` en cada lectura.
   */
  @Column({ name: 'portal_admin_enc', type: 'text', nullable: true })
  portalAdminEnc!: string | null;

  @Column({ name: 'portal_cps_enc', type: 'text', nullable: true })
  portalCpsEnc!: string | null;

  @Column({ name: 'portal_derived_at', type: 'timestamptz', nullable: true })
  portalDerivedAt!: Date | null;

  /**
   * Cuándo se imprimió y pegó la etiqueta del equipo. Es el tercer hito de la
   * puesta en marcha; la ETAPA no se guarda, se deriva del último alcanzado
   * (ver `deviceStage` en el serializer).
   */
  @Column({ name: 'labeled_at', type: 'timestamptz', nullable: true })
  labeledAt!: Date | null;

  @Column({ name: 'labeled_by', type: 'int', nullable: true })
  labeledBy!: number | null;

  /**
   * Primera vez que el equipo apareció en el broker. Es un hecho OBSERVADO:
   * por la regla 5 del dominio lo escribe el servicio de alarmas, no la web.
   * Mientras el GtD no exista, CPS puede marcarlo a mano — y en ese caso
   * `firstConnectionSource` queda en MANUAL y el override va a `audit_log`.
   * Un dato medido y uno cargado a dedo no valen lo mismo.
   */
  @Column({ name: 'first_connection_at', type: 'timestamptz', nullable: true })
  firstConnectionAt!: Date | null;

  @Column({
    name: 'first_connection_source',
    type: 'enum',
    enum: DeviceMilestoneSource,
    enumName: 'device_milestone_source',
    nullable: true,
  })
  firstConnectionSource!: DeviceMilestoneSource | null;

  @Column({ name: 'first_connection_by', type: 'int', nullable: true })
  firstConnectionBy!: number | null;

  /** Dueño del stock mientras está en INVENTORY. NULL = fábrica CPS. */
  @Column({ name: 'organization_id', type: 'int', nullable: true })
  organizationId!: number | null;

  @ManyToOne(() => Account, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'device_organization_id_fkey',
  })
  organization!: Account | null;

  /** NULL solo en INVENTORY (lo garantiza el CHECK). */
  @Column({ name: 'neighborhood_id', type: 'int', nullable: true })
  neighborhoodId!: number | null;

  @ManyToOne(() => Neighborhood, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({
    name: 'neighborhood_id',
    foreignKeyConstraintName: 'device_neighborhood_id_fkey',
  })
  neighborhood!: Neighborhood | null;

  /**
   * OBLIGATORIAS en un equipo instalado, y NULL mientras está en inventario:
   * el `chk_device_gps` lo impone. Un poste sin punto en el mapa no se puede
   * monitorear —el tablero ES un mapa—, pero un equipo en una caja no tiene
   * ubicación que declarar.
   */
  @Column({ type: 'double precision', nullable: true })
  latitude!: number | null;

  @Column({ type: 'double precision', nullable: true })
  longitude!: number | null;

  @Column({ name: 'installed_at', type: 'timestamptz', nullable: true })
  installedAt!: Date | null;

  // --- Datos de INSTALACIÓN -------------------------------------------------
  // Lo que un técnico necesita saber ANTES de subirse a la escalera. Todos
  // OPCIONALES (nadie mide la altura colgado de una escalera) pero
  // recomendados, y editables después del alta.

  /** Número de poste o columna donde está montada. */
  @Column({ name: 'pole_number', type: 'text', nullable: true })
  poleNumber!: string | null;

  /**
   * Altura de montaje en metros. NUMERIC como el precio y por lo mismo: el
   * driver lo entrega string para no perder precisión.
   */
  @Column({
    name: 'height_m',
    type: 'numeric',
    precision: 4,
    scale: 1,
    nullable: true,
    transformer: {
      to: (value: number | null) => value,
      from: (value: string | null) => (value === null ? null : Number(value)),
    },
  })
  heightM!: number | null;

  /** La esquina, entre qué calles. */
  @Column({ type: 'text', nullable: true })
  reference!: string | null;

  /** De qué luminaria o tablero toma energía. */
  @Column({ name: 'power_point', type: 'text', nullable: true })
  powerPoint!: string | null;

  /** Lo que no entra en los otros cuatro. */
  @Column({ name: 'install_notes', type: 'text', nullable: true })
  installNotes!: string | null;

  /**
   * Sacado de circulación: no aparece en ninguna lista, pero sigue existiendo.
   *
   * Es un eje APARTE de `status`, no un estado más del ciclo de vida. `status`
   * dice en qué punto está el equipo (en stock, operativo, en mantenimiento);
   * esto dice si alguien lo sacó. Un equipo puede estar OPERATIONAL y removido,
   * y las dos cosas son verdad al mismo tiempo.
   *
   * Tampoco podría ser `RETIRED` aunque quisiéramos: el CHECK de custodia exige
   * barrio para todo lo que no está en INVENTORY, y un equipo de fábrica no
   * tiene ninguno.
   */
  @Column({ name: 'removed_at', type: 'timestamptz', nullable: true })
  removedAt!: Date | null;

  @Column({ name: 'removed_by', type: 'int', nullable: true })
  removedBy!: number | null;

  @Column({ name: 'created_by', type: 'int', nullable: true })
  createdBy!: number | null;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => DeviceMaintenance, (m) => m.device)
  maintenances!: DeviceMaintenance[];
}
