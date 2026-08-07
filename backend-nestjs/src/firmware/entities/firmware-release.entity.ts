import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * Un firmware subido al catálogo. La ficha del `.bin`, no el `.bin`.
 *
 * El binario vive en el disco del servidor (`FIRMWARE_ROOT`) y lo sirve nginx
 * desde el apex `cpssecurity.com.ar`, que es el único host que la allowlist del
 * equipo acepta. Acá está lo que el manifiesto tiene que declarar.
 *
 * Ninguno de estos campos se tipea: `version`, `project_name`, `size_bytes` y
 * `sha256` salen del archivo en el momento de la subida. Lo único que escribe
 * una persona son las notas.
 */
@Entity('firmware_release')
@Check('chk_firmware_channel', "channel IN ('new', 'stable')")
@Check('chk_firmware_sha', "sha256 ~ '^[0-9a-f]{64}$'")
@Check('chk_firmware_size', 'size_bytes > 0 AND size_bytes <= 1835008')
export class FirmwareRelease {
  @PrimaryGeneratedColumn()
  id!: number;

  /**
   * `new_0_7_0`. Es el nombre de la carpeta y del archivo: el equipo arma la
   * URL como `base + version + ".bin"`.
   */
  @Column({ type: 'text', unique: true })
  version!: string;

  /** `new` o `stable`, del prefijo. Es registro: el firmware nunca bloquea por canal. */
  @Column({ type: 'text' })
  channel!: string;

  /** Debe coincidir con el `OTA_HW_MODEL` del equipo o el manifiesto se rechaza. */
  @Column({ name: 'hw_model', type: 'text', default: 'esp32-4mb' })
  hwModel!: string;

  /** El equipo verifica que el binario sea del mismo proyecto antes de activarlo. */
  @Column({ name: 'project_name', type: 'text' })
  projectName!: string;

  @Column({ name: 'size_bytes', type: 'int' })
  sizeBytes!: number;

  /** 64 hex. Se compara contra lo escrito en flash antes de marcar booteable. */
  @Column({ type: 'text' })
  sha256!: string;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ name: 'uploaded_by', type: 'int', nullable: true })
  uploadedBy!: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'uploaded_by' })
  uploader!: User | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
