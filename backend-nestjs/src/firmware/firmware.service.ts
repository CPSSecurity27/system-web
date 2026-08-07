import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { Repository } from 'typeorm';
import type { AuthenticatedUser } from '../auth/auth.service';
import { AuditService } from '../common/audit.service';
import {
  FirmwareChannel,
  FirmwareSlot,
} from './entities/firmware-channel.entity';
import { FirmwareRelease } from './entities/firmware-release.entity';
import {
  armarManifiesto,
  canalDeVersion,
  carpetaDeRanura,
  carpetaDeVersion,
  HW_MODEL,
  MAX_BIN_BYTES,
  nombreDelBin,
  urlDeCarpeta,
  validarVersion,
} from './firmware-catalog';
import { EspImageError, leerDescriptorEsp } from './esp-image';
import type { EspAppDesc } from './esp-image';
import { FirmwareReleaseView, RanuraView } from './dto/firmware.dto';

/**
 * El catálogo de firmwares: subir un `.bin`, sembrarlo en el servidor y decidir
 * qué versión está publicada en cada una de las dos bases del equipo.
 *
 * ## Dónde viven los archivos y por qué no en la base
 *
 * El `.bin` va al disco, bajo `FIRMWARE_ROOT`, y lo sirve **nginx desde el apex
 * `cpssecurity.com.ar`**. No pasa por Node: mientras una tanda de postes baja
 * 1,2 MB cada uno, el backend tiene que seguir atendiendo la web.
 *
 * En la base queda la ficha. Un `bytea` de 1,2 MB por versión no aporta nada
 * —igual habría que escribirlo al disco para que nginx lo sirva— y hace pesado
 * cada backup.
 *
 * ## El disco y la base pueden desincronizarse, y se asume
 *
 * Se escribe primero el archivo y después la fila. Si falla la fila, el archivo
 * queda huérfano en el disco y no lo ve nadie (el catálogo se lista desde la
 * base): molesta, no rompe. Al revés —fila sin archivo— sí rompería, porque la
 * pantalla ofrecería publicar algo que no existe, y por eso ese orden.
 */
@Injectable()
export class FirmwareService {
  private readonly logger = new Logger(FirmwareService.name);

  constructor(
    @InjectRepository(FirmwareRelease)
    private readonly releases: Repository<FirmwareRelease>,
    @InjectRepository(FirmwareChannel)
    private readonly channels: Repository<FirmwareChannel>,
    private readonly audit: AuditService,
  ) {}

  /**
   * La raíz en disco. En el servidor es
   * `/home/servidorcps/SistemaCPS/web/firmware`, y nginx la publica en
   * `https://cpssecurity.com.ar/firmware/`.
   */
  private raiz(): string {
    const root = process.env.FIRMWARE_ROOT;
    if (!root || root.trim().length === 0) {
      throw new InternalServerErrorException(
        'FIRMWARE_ROOT no está configurado: el servidor no sabe dónde guardar los firmwares',
      );
    }
    return resolve(root);
  }

  // ── Subir ────────────────────────────────────────────────────────

  /**
   * Da de alta un firmware: valida el binario, lo siembra y lo registra.
   *
   * La versión la escribe una persona y no sale del archivo, y eso NO es un
   * atajo: el `CMakeLists.txt` del firmware no define `PROJECT_VER`, así que el
   * binario declara el `git describe` (`f1a0459-dirty`) y no la versión OTA.
   * Lo que sí sale del archivo es todo lo demás — `project_name`, tamaño y
   * sha256— y con eso alcanza para que un `.bin` no pueda quedar mal descripto.
   */
  async subir(
    archivo: { buffer: Buffer; originalname?: string },
    datos: { version: string; notes?: string },
    user: AuthenticatedUser,
  ): Promise<FirmwareReleaseView> {
    const version = datos.version.trim();

    const errores = validarVersion(version);
    if (errores.length > 0) throw new BadRequestException(errores);

    if (!archivo?.buffer || archivo.buffer.length === 0) {
      throw new BadRequestException('No llegó ningún archivo');
    }
    if (archivo.buffer.length > MAX_BIN_BYTES) {
      throw new BadRequestException(
        `El firmware pesa ${archivo.buffer.length} bytes y el slot OTA del equipo ` +
          `es de ${MAX_BIN_BYTES}: no entra, y el equipo lo rechazaría recién ` +
          `después de bajar el manifiesto`,
      );
    }

    let desc: EspAppDesc;
    try {
      desc = leerDescriptorEsp(archivo.buffer);
    } catch (e) {
      if (e instanceof EspImageError) throw new BadRequestException(e.message);
      throw e;
    }

    const sha256 = createHash('sha256').update(archivo.buffer).digest('hex');

    // Mismo binario con otro nombre: la flota reportaría dos versiones para un
    // solo build y no habría forma de saber cuál corre en un poste.
    const gemelo = await this.releases.findOne({ where: { sha256 } });
    if (gemelo) {
      throw new ConflictException(
        `Este binario ya está cargado como "${gemelo.version}": es byte por byte el mismo archivo`,
      );
    }

    if (await this.releases.findOne({ where: { version } })) {
      throw new ConflictException(
        `Ya existe la versión "${version}". Una versión publicada no se pisa: ` +
          `los equipos que ya la bajaron reportarían ese nombre corriendo otro binario`,
      );
    }

    // El archivo primero: una fila sin archivo ofrecería publicar un 404.
    const carpeta = carpetaDeVersion(version);
    await this.escribirPar(carpeta, nombreDelBin(version), archivo.buffer, {
      version,
      hwModel: HW_MODEL,
      sizeBytes: archivo.buffer.length,
      sha256,
    });

    const release = await this.releases.save(
      this.releases.create({
        version,
        channel: canalDeVersion(version),
        hwModel: HW_MODEL,
        projectName: desc.projectName,
        sizeBytes: archivo.buffer.length,
        sha256,
        notes: datos.notes?.trim() || null,
        uploadedBy: user.id,
      }),
    );

    await this.audit.record({
      actorUserId: user.id,
      action: 'firmware.upload',
      entityType: 'firmware_release',
      entityId: release.id,
      newValue: {
        version,
        sha256,
        sizeBytes: release.sizeBytes,
        projectName: desc.projectName,
        buildVersion: desc.buildVersion,
        builtAt: desc.builtAt,
        idfVersion: desc.idfVersion,
        archivo: archivo.originalname ?? null,
      },
    });

    this.logger.log(
      `Firmware ${version} cargado (${release.sizeBytes} B, ${desc.projectName}, build ${desc.buildVersion})`,
    );

    return this.aVista(release, await this.ranurasPorRelease());
  }

  /** Escribe `manifest.json` + el `.bin` en una carpeta, creándola si hace falta. */
  private async escribirPar(
    carpetaRelativa: string,
    nombreBin: string,
    bin: Buffer,
    manifiesto: {
      version: string;
      hwModel: string;
      sizeBytes: number;
      sha256: string;
    },
  ): Promise<void> {
    const destino = join(this.raiz(), carpetaRelativa);
    await fs.mkdir(destino, { recursive: true });
    await fs.writeFile(join(destino, nombreBin), bin);
    // El manifiesto DESPUÉS del binario: es el que el equipo lee primero, y si
    // aparece antes que el .bin hay una ventana en la que promete un archivo
    // que todavía no está.
    await fs.writeFile(
      join(destino, 'manifest.json'),
      JSON.stringify(armarManifiesto(manifiesto), null, 2) + '\n',
      'utf8',
    );
  }

  // ── Publicar ─────────────────────────────────────────────────────

  /**
   * Pone una versión en una de las dos bases fijas del equipo.
   *
   * Es una COPIA y no un symlink: el equipo arma la URL como base + archivo, así
   * que el `.bin` tiene que estar físicamente en la misma carpeta que su
   * `manifest.json`. 1,2 MB duplicados no son nada y se razona mucho mejor
   * cuando algo falla a las tres de la mañana.
   */
  async publicar(
    id: number,
    slot: FirmwareSlot,
    user: AuthenticatedUser,
  ): Promise<RanuraView[]> {
    const release = await this.releases.findOne({ where: { id } });
    if (!release) throw new NotFoundException('Esa versión no existe');

    const bin = await this.leerBin(release);

    await this.escribirPar(
      carpetaDeRanura(slot),
      nombreDelBin(release.version, slot),
      bin,
      {
        version: release.version,
        hwModel: release.hwModel,
        sizeBytes: release.sizeBytes,
        sha256: release.sha256,
      },
    );

    const anterior = await this.channels.findOne({ where: { slot } });

    await this.channels.save(
      this.channels.create({
        slot,
        releaseId: release.id,
        updatedBy: user.id,
      }),
    );

    await this.audit.record({
      actorUserId: user.id,
      action: `firmware.publish.${slot}`,
      entityType: 'firmware_release',
      entityId: release.id,
      oldValue: anterior ? { releaseId: anterior.releaseId } : null,
      newValue: { slot, version: release.version },
    });

    this.logger.log(
      `Firmware ${release.version} publicado en la ranura ${slot}`,
    );

    return this.ranuras();
  }

  private async leerBin(release: FirmwareRelease): Promise<Buffer> {
    const ruta = join(
      this.raiz(),
      carpetaDeVersion(release.version),
      nombreDelBin(release.version),
    );
    let bin: Buffer;
    try {
      bin = await fs.readFile(ruta);
    } catch {
      throw new ConflictException(
        `El archivo de "${release.version}" no está en el servidor. ` +
          `Está en el catálogo pero no en el disco: hay que volver a subirlo`,
      );
    }
    // Barato y ataja el caso feo: el archivo cambió abajo nuestro y estaríamos
    // publicando algo distinto de lo que dice el manifiesto que vamos a escribir.
    const sha = createHash('sha256').update(bin).digest('hex');
    if (sha !== release.sha256) {
      throw new ConflictException(
        `El archivo de "${release.version}" en el disco no coincide con el sha256 ` +
          `registrado. No se publica: el equipo lo rechazaría después de bajarlo entero`,
      );
    }
    return bin;
  }

  // ── Listar ───────────────────────────────────────────────────────

  async listar(): Promise<FirmwareReleaseView[]> {
    const [filas, ranuras] = await Promise.all([
      this.releases.find({
        relations: { uploader: true },
        order: { createdAt: 'DESC' },
      }),
      this.ranurasPorRelease(),
    ]);
    return filas.map((f) => this.aVista(f, ranuras));
  }

  async ranuras(): Promise<RanuraView[]> {
    const filas = await this.channels.find({
      relations: { release: true, updater: true },
    });
    return filas.map((f) => ({
      slot: f.slot,
      version: f.release.version,
      releaseId: f.releaseId,
      url: urlDeCarpeta(carpetaDeRanura(f.slot)),
      actualizadoPor: f.updater?.name ?? null,
      actualizadoEn: f.updatedAt.toISOString(),
    }));
  }

  /** `{ releaseId → ranuras en las que está publicado }`. */
  private async ranurasPorRelease(): Promise<Map<number, FirmwareSlot[]>> {
    const filas = await this.channels.find();
    const mapa = new Map<number, FirmwareSlot[]>();
    for (const f of filas) {
      mapa.set(f.releaseId, [...(mapa.get(f.releaseId) ?? []), f.slot]);
    }
    return mapa;
  }

  private aVista(
    release: FirmwareRelease,
    ranuras: Map<number, FirmwareSlot[]>,
  ): FirmwareReleaseView {
    return {
      id: release.id,
      version: release.version,
      channel: release.channel,
      hwModel: release.hwModel,
      projectName: release.projectName,
      sizeBytes: release.sizeBytes,
      sha256: release.sha256,
      notes: release.notes,
      subidoPor: release.uploader?.name ?? null,
      creadoEn: release.createdAt.toISOString(),
      url: urlDeCarpeta(carpetaDeVersion(release.version)),
      publicadoEn: ranuras.get(release.id) ?? [],
    };
  }

  // ── Borrar ───────────────────────────────────────────────────────

  /**
   * Saca una versión del catálogo y del disco.
   *
   * Una versión publicada NO se borra: la FK es RESTRICT y acá se explica por
   * qué antes de que Postgres tire un error de constraint. Dejar la carpeta
   * `new/` apuntando a algo que ya no está significa que el próximo `cmd t:ota`
   * baja un 404 — y el equipo suma un intento fallido por eso.
   */
  async borrar(id: number, user: AuthenticatedUser): Promise<void> {
    const release = await this.releases.findOne({ where: { id } });
    if (!release) throw new NotFoundException('Esa versión no existe');

    const publicada = await this.channels.find({ where: { releaseId: id } });
    if (publicada.length > 0) {
      const donde = publicada.map((p) => p.slot).join(' y ');
      throw new ConflictException(
        `"${release.version}" está publicada en ${donde}. Publicá otra versión ` +
          `en esa ranura antes de borrarla`,
      );
    }

    await this.releases.delete(id);

    // El archivo después de la fila: si falla el borrado del disco queda basura
    // invisible, que es mucho mejor que una fila apuntando a un archivo muerto.
    const carpeta = join(this.raiz(), carpetaDeVersion(release.version));
    try {
      await fs.rm(carpeta, { recursive: true, force: true });
    } catch (e) {
      this.logger.error(
        `Firmware ${release.version} borrado del catálogo pero la carpeta ${carpeta} sigue en el disco: ${String(e)}`,
      );
    }

    await this.audit.record({
      actorUserId: user.id,
      action: 'firmware.delete',
      entityType: 'firmware_release',
      entityId: id,
      oldValue: { version: release.version, sha256: release.sha256 },
    });
  }

  // ── Diagnóstico ──────────────────────────────────────────────────

  /**
   * ¿El servidor está realmente sirviendo lo que la base dice?
   *
   * Existe porque el modo de falla de todo esto es silencioso: la pantalla
   * muestra el catálogo desde la base, y si nginx no tiene el `location
   * /firmware/` —o `FIRMWARE_ROOT` apunta a otro lado— todo se ve perfecto
   * hasta que un poste intenta actualizar y baja un 404.
   */
  async verificar(): Promise<{
    raiz: string;
    escribible: boolean;
    ranuras: { slot: string; version: string; archivos: string[] }[];
    faltantes: string[];
  }> {
    const raiz = this.raiz();
    let escribible = true;
    try {
      await fs.mkdir(raiz, { recursive: true });
      await fs.access(raiz, fsConstants.W_OK);
    } catch {
      escribible = false;
    }

    const releases = await this.releases.find();
    const faltantes: string[] = [];
    for (const r of releases) {
      const ruta = join(
        raiz,
        carpetaDeVersion(r.version),
        nombreDelBin(r.version),
      );
      try {
        await fs.access(ruta);
      } catch {
        faltantes.push(r.version);
      }
    }

    const ranuras: { slot: string; version: string; archivos: string[] }[] = [];
    for (const c of await this.channels.find({
      relations: { release: true },
    })) {
      const carpeta = join(raiz, carpetaDeRanura(c.slot));
      let archivos: string[] = [];
      try {
        archivos = await fs.readdir(carpeta);
      } catch {
        archivos = [];
      }
      ranuras.push({
        slot: c.slot,
        version: c.release.version,
        archivos,
      });
    }

    return { raiz, escribible, ranuras, faltantes };
  }

  /** La versión publicada en `new`, que es contra la que se compara la flota. */
  async versionPublicada(): Promise<string | null> {
    const fila = await this.channels.findOne({
      where: { slot: 'new' },
      relations: { release: true },
    });
    return fila?.release.version ?? null;
  }
}
