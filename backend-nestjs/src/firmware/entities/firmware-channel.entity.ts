import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { FirmwareRelease } from './firmware-release.entity';

/** Las dos bases que el firmware tiene hardcodeadas. */
export const FIRMWARE_SLOTS = ['new', 'emergency'] as const;
export type FirmwareSlot = (typeof FIRMWARE_SLOTS)[number];

/**
 * Qué versión está publicada en cada ranura. Es un PUNTERO, no una copia.
 *
 * La ranura es la clave primaria: publicar es un UPSERT y no puede haber dos
 * versiones peleando por la misma base.
 *
 * **Las dos ranuras no son lo mismo y no se manejan igual:**
 *
 * - `new` es la que baja un `cmd t:ota` con `fuente: "auto"`. Es la última que
 *   queremos desplegar, y se cambia cada vez que sale una versión.
 * - `emergency` es el ÚLTIMO BUENO CONOCIDO. El equipo la baja SOLO, sin que
 *   nadie se lo pida, cuando decide que está roto. Si se publica ahí la misma
 *   versión de la que está tratando de escapar, el mecanismo deja de existir.
 */
@Entity('firmware_channel')
@Check('chk_firmware_slot', "slot IN ('new', 'emergency')")
export class FirmwareChannel {
  @PrimaryColumn({ type: 'text' })
  slot!: FirmwareSlot;

  @Column({ name: 'release_id', type: 'int' })
  releaseId!: number;

  /**
   * RESTRICT: borrar una versión publicada tiene que fallar y decirlo. Si no,
   * la carpeta del servidor queda apuntando a un archivo que ya no está en el
   * catálogo y el equipo baja un 404 en el peor momento posible.
   */
  @ManyToOne(() => FirmwareRelease, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'release_id' })
  release!: FirmwareRelease;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy!: number | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'updated_by' })
  updater!: User | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
