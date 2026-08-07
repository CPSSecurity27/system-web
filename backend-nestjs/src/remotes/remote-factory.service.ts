import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  ILike,
  IsNull,
  Not,
  Repository,
} from 'typeorm';
import { AuditService } from '../common/audit.service';
import { generarClaimCode } from '../common/claim-code';
import { esViolacionDeClaveForanea } from '../common/db-errors';
import { CryptoService } from '../common/crypto.service';
import { RemoteStatus } from '../common/enums';
import {
  CreateRemoteModelDto,
  ManufactureRemoteDto,
  UpdateRemoteModelDto,
} from './dto/remote-factory.dto';
import {
  EtiquetaControl,
  RemoteFabricado,
  ResultadoBusqueda,
} from './dto/remote-factory.dto';
import { RemoteCode } from './entities/remote-code.entity';
import { RemoteModel } from './entities/remote-model.entity';
import { Remote } from './entities/remote.entity';
import {
  CODE_MAX,
  codigoValido,
  errorDeCodigo,
  generarCodigo,
  MAX_CODIGOS,
  POSICIONES,
} from './remote-codes';

/** Cuántas veces se vuelve a sortear un código que ya existe. */
const REINTENTOS_SORTEO = 5;

/**
 * Cuántos números correlativos se saltean buscando uno libre.
 *
 * Mucho más alto que los reintentos del sorteo, y por una razón: al azar, una
 * colisión en 10^12 valores es un accidente; en correlativo, los tomados están
 * TODOS JUNTOS —es lo que pasa si alguien ya cargó una tanda— y hay que
 * atravesarlos. Con un tope igual al del sorteo, el modo correlativo se rendiría
 * apenas alcanza a la tanda anterior.
 */
const SALTOS_CORRELATIVO = 500;

/**
 * Fábrica de controles remotos.
 *
 * El alta es ATÓMICA, igual que la del equipo: modelo, serial y los códigos
 * entran en una sola transacción. Antes se creaba el control y los códigos se
 * cargaban después de a uno, así que un control a medio cargar era un estado
 * normal de la base — y un control sin códigos es un llavero que no hace nada.
 *
 * Los códigos los ELIGE CPS y se graban en el control, no al revés. Eso saca del
 * medio el error de tipeo, que en este dominio no es un detalle: el panel
 * resuelve a qué vecino corresponde una alarma buscando el número en su base
 * local, así que un dígito mal copiado es una alarma atribuida a otra casa.
 */
@Injectable()
export class RemoteFactoryService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Remote) private readonly remotes: Repository<Remote>,
    @InjectRepository(RemoteModel)
    private readonly models: Repository<RemoteModel>,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  // ── Catálogo de modelos ───────────────────────────────────────────

  findModels(): Promise<RemoteModel[]> {
    return this.models.find({ order: { buttons: 'ASC', code: 'ASC' } });
  }

  async createModel(
    dto: CreateRemoteModelDto,
    userId: number,
  ): Promise<RemoteModel> {
    const model = await this.models.save(
      this.models.create({
        code: dto.code.toUpperCase(),
        name: dto.name,
        buttons: dto.buttons,
        notes: dto.notes ?? null,
      }),
    );
    await this.audit.record({
      actorUserId: userId,
      action: 'remote_model.create',
      entityType: 'remote_model',
      entityId: model.id,
      newValue: { code: model.code, buttons: model.buttons },
    });
    return model;
  }

  /** Un modelo no se borra: se discontinúa con `active: false`. */
  async updateModel(
    id: number,
    dto: UpdateRemoteModelDto,
    userId: number,
  ): Promise<RemoteModel> {
    const model = await this.models.findOne({ where: { id } });
    if (!model) throw new NotFoundException(`No existe el modelo ${id}`);

    Object.assign(model, {
      name: dto.name ?? model.name,
      notes: dto.notes ?? model.notes,
      active: dto.active ?? model.active,
    });
    const guardado = await this.models.save(model);

    await this.audit.record({
      actorUserId: userId,
      action: 'remote_model.update',
      entityType: 'remote_model',
      entityId: id,
      newValue: { name: guardado.name, active: guardado.active },
    });
    return guardado;
  }

  // ── Fabricación ───────────────────────────────────────────────────

  /**
   * Sortea un código que no exista todavía.
   *
   * La unicidad la impone el índice sobre el HMAC, no esta función: acá se
   * pregunta antes para no gastar un intento de INSERT, pero la garantía real es
   * la del índice, que también atrapa una carrera entre dos operarios
   * fabricando al mismo tiempo.
   *
   * Con 10^12 valores posibles, una colisión es un accidente estadístico; los
   * reintentos existen para eso y no para un espacio saturado.
   */
  private async codigoLibre(
    manager: EntityManager,
    usados: Set<string>,
  ): Promise<{ codigo: number; hmac: Buffer }> {
    for (let intento = 0; intento < REINTENTOS_SORTEO; intento++) {
      const codigo = generarCodigo();
      const hmac = this.crypto.fingerprint(String(codigo));
      const clave = hmac.toString('hex');

      // Contra los otros códigos de ESTE mismo control, que todavía no están
      // en la base.
      if (usados.has(clave)) continue;

      const existe = await manager.getRepository(RemoteCode).findOne({
        where: { codeHmac: hmac },
        select: { id: true },
      });
      if (!existe) {
        usados.add(clave);
        return { codigo, hmac };
      }
    }
    throw new ConflictException(
      'No se pudo generar un código libre. Probá de nuevo; si sigue pasando, avisá.',
    );
  }

  /**
   * El siguiente de la numeración, salteando los que ya estén tomados.
   *
   * Los dos chequeos son los mismos que en el sorteo y hacen falta igual —o
   * más—: en correlativo los códigos ocupados están todos juntos, así que
   * alcanzar una tanda anterior no es raro, es lo normal cuando dos personas
   * fabrican el mismo día.
   *
   * `nextval` no vuelve atrás si la transacción falla. Es lo correcto: un número
   * quemado no le hace mal a nadie, uno repetido sí.
   */
  private async codigoCorrelativo(
    manager: EntityManager,
    usados: Set<string>,
  ): Promise<{ codigo: number; hmac: Buffer }> {
    for (let salto = 0; salto < SALTOS_CORRELATIVO; salto++) {
      const [{ nextval }] = await manager.query<{ nextval: string }[]>(
        `SELECT nextval('remote_code_seq')`,
      );
      const codigo = Number(nextval);

      // La secuencia no conoce el techo del panel: si lo pasa, no hay más
      // numeración correlativa posible y hay que decirlo, no dar la vuelta.
      // Solo se mira el techo: la secuencia arranca sobre el piso y solo crece.
      if (codigo > CODE_MAX) {
        throw new ConflictException(
          `La numeración correlativa llegó a ${codigo}, que se pasa de lo que el equipo guarda (${CODE_MAX}). Fabricá con códigos al azar.`,
        );
      }

      const hmac = this.crypto.fingerprint(String(codigo));
      const clave = hmac.toString('hex');
      if (usados.has(clave)) continue;

      const existe = await manager.getRepository(RemoteCode).findOne({
        where: { codeHmac: hmac },
        select: { id: true },
      });
      if (!existe) {
        usados.add(clave);
        return { codigo, hmac };
      }
    }
    throw new ConflictException(
      `Se saltearon ${SALTOS_CORRELATIVO} números seguidos y todos estaban tomados. Fabricá con códigos al azar.`,
    );
  }

  /** El que el operario tipeó, validado y chequeado contra los que ya existen. */
  private async codigoManual(
    manager: EntityManager,
    valor: unknown,
    posicion: number,
    usados: Set<string>,
  ): Promise<{ codigo: number; hmac: Buffer }> {
    const error = errorDeCodigo(valor, posicion);
    if (error) throw new BadRequestException(error);

    const codigo = valor as number;
    const hmac = this.crypto.fingerprint(String(codigo));
    const clave = hmac.toString('hex');

    if (usados.has(clave)) {
      throw new BadRequestException(
        `El código ${codigo} está repetido dentro de este mismo control`,
      );
    }
    const existe = await manager.getRepository(RemoteCode).findOne({
      where: { codeHmac: hmac },
      select: { id: true },
    });
    if (existe) {
      // No se dice de QUÉ control es: quien fabrica no tiene por qué poder
      // sondear los códigos de la flota preguntando de a uno.
      throw new ConflictException(
        `El código ${codigo} ya está cargado en otro control`,
      );
    }
    usados.add(clave);
    return { codigo, hmac };
  }

  /**
   * Fabrica un control: modelo + serial + sus códigos, todo o nada.
   *
   * `codigos` es OPCIONAL. Vacío = los genera el sistema, que es el camino
   * normal. Se aceptan tipeados para el caso en que el hardware no se deje
   * programar y haya que copiar los que ya trae: es el mismo formulario, con los
   * campos editables, y la validación es idéntica.
   */
  async manufacture(
    dto: ManufactureRemoteDto,
    userId: number,
  ): Promise<RemoteFabricado> {
    const model = await this.models.findOne({ where: { id: dto.modelId } });
    if (!model)
      throw new NotFoundException(`No existe el modelo ${dto.modelId}`);
    if (!model.active) {
      throw new BadRequestException(
        `El modelo ${model.code} está discontinuado: no se fabrica más`,
      );
    }

    // Cuántos códigos lleva: los botones del modelo, con el tope del panel.
    // Un modelo de 6 botones registra 4 — los otros dos no tienen dónde ir.
    const cantidad = Math.min(model.buttons, MAX_CODIGOS);

    const manuales = dto.codigos ?? [];
    if (manuales.length > 0 && manuales.length !== cantidad) {
      throw new BadRequestException(
        `Este modelo lleva ${cantidad} códigos y mandaste ${manuales.length}. ` +
          `O los cargás todos, o no mandás ninguno y los genera el sistema.`,
      );
    }

    const { remote, codigos } = await this.dataSource.transaction(
      async (manager) => {
        const [{ nextval }] = await manager.query<{ nextval: string }[]>(
          `SELECT nextval('remote_serial_seq')`,
        );
        const serial = `CR-${String(nextval).padStart(6, '0')}`;

        const guardado = await manager.getRepository(Remote).save(
          manager.getRepository(Remote).create({
            serial,
            modelId: model.id,
            // El código con el que un cliente lo suma a su stock. Va impreso en
            // la etiqueta: sin él, el único camino al inventario de una muni
            // sería que CPS le despache el lote.
            claimCode: generarClaimCode(),
            // Sin apodo: en la fábrica se trabaja por número de serie. El
            // nombre lo pone la familia cuando el control llega a una casa.
            name: null,
            status: RemoteStatus.INVENTORY,
            organizationId: null,
            manufacturedAt: new Date(),
            manufacturedBy: userId,
            createdBy: userId,
          }),
        );

        const usados = new Set<string>();
        const codigos: { position: number; codigo: number }[] = [];

        for (let i = 0; i < cantidad; i++) {
          const position = i + 1;
          const { codigo, hmac } =
            manuales.length > 0
              ? await this.codigoManual(manager, manuales[i], position, usados)
              : dto.correlativo
                ? await this.codigoCorrelativo(manager, usados)
                : await this.codigoLibre(manager, usados);

          await manager.getRepository(RemoteCode).insert({
            remoteId: guardado.id,
            position,
            codeEncrypted: this.crypto.encrypt(String(codigo)),
            codeHmac: hmac,
          });
          codigos.push({ position, codigo });
        }

        return { remote: guardado, codigos };
      },
    );

    await this.audit.record({
      actorUserId: userId,
      action: 'remote.manufacture',
      entityType: 'remote',
      entityId: remote.id,
      // Los códigos NO van al audit_log: es una tabla que se lee sin ceremonia
      // y son justamente el secreto. Queda el hecho, no el contenido.
      newValue: {
        serial: remote.serial,
        modelo: model.code,
        codigos: cantidad,
      },
    });

    return this.armarVista(remote, model, codigos);
  }

  /**
   * Qué botón es esa posición. Un modelo con más de 4 botones no tiene entrada
   * en la tabla del firmware para el quinto: se muestra crudo antes que romper.
   */
  private botonDe(position: number): {
    position: number;
    boton: string;
    modo: string;
    label: string;
  } {
    const conocida = POSICIONES.find((p) => p.position === position);
    return conocida
      ? { ...conocida }
      : {
          position,
          boton: String(position),
          modo: 'desconocido',
          label: `Botón ${position}`,
        };
  }

  private armarVista(
    remote: Remote,
    model: RemoteModel,
    codigos: { position: number; codigo: number }[],
  ): RemoteFabricado {
    return {
      id: remote.id,
      serial: remote.serial!,
      claimCode: remote.claimCode,
      name: remote.name,
      modelo: {
        id: model.id,
        code: model.code,
        name: model.name,
        buttons: model.buttons,
      },
      manufacturedAt: remote.manufacturedAt!.toISOString(),
      codigos: codigos.map((c) => ({
        ...this.botonDe(c.position),
        codigo: c.codigo,
      })),
    };
  }

  /**
   * Todo lo fabricado, lo último arriba. Es el registro de la fábrica.
   *
   * Trae los que tienen serial, o sea los que pasaron por `manufacture`: los
   * controles anteriores no tienen nada que mostrar acá y ensuciarían la lista
   * con filas sin identidad.
   */
  async fabricados(): Promise<ResultadoBusqueda[]> {
    const filas = await this.remotes.find({
      where: { serial: Not(IsNull()), removedAt: IsNull() },
      relations: { model: true },
      order: { id: 'DESC' },
      take: 200,
    });
    return filas.map((r) => this.armarResultado(r, 'serial', null));
  }

  /**
   * Marca o desmarca el visto bueno de fábrica.
   *
   * Reversible a propósito, igual que en el equipo: el error más común es
   * marcar de más, y obligar a borrar el control para corregirlo sería peor que
   * el error. Las dos direcciones quedan en `audit_log`.
   */
  async marcarListo(
    id: number,
    listo: boolean,
    userId: number,
  ): Promise<ResultadoBusqueda> {
    const remote = await this.remotes.findOne({
      where: { id },
      relations: { model: true },
    });
    if (!remote) throw new NotFoundException(`No existe el control ${id}`);
    if (!remote.serial) {
      throw new ConflictException(
        'Este control es anterior a la fábrica: no pasa por el visto bueno',
      );
    }

    remote.readyAt = listo ? new Date() : null;
    remote.readyBy = listo ? userId : null;
    const guardado = await this.remotes.save(remote);

    await this.audit.record({
      actorUserId: userId,
      action: listo ? 'remote.ready' : 'remote.ready_undo',
      entityType: 'remote',
      entityId: id,
      newValue: { serial: remote.serial, listo },
    });

    return this.armarResultado(guardado, 'serial', null);
  }

  // ── Papelera ──────────────────────────────────────────────────────

  /** Los removidos. No aparecen en ninguna otra lista. */
  async removidos(): Promise<ResultadoBusqueda[]> {
    const filas = await this.remotes.find({
      where: { removedAt: Not(IsNull()) },
      relations: { model: true },
      order: { removedAt: 'DESC' },
    });
    return filas.map((r) => this.armarResultado(r, 'serial', null));
  }

  /**
   * A la papelera. Lo saca de todas las listas y lo devuelve al stock de fábrica.
   *
   * **Lo que esto NO hace: dejar el control sin efecto.** Sus códigos viven en
   * la EEPROM de cada panel del barrio y la web todavía no los sincroniza, así
   * que el llavero sigue disparando la alarma. Es el mismo agujero que en el
   * equipo se cerró revocando la credencial del broker; acá el equivalente es un
   * `cmd t:rf op:del` a cada panel, y hasta que exista, esto es administrativo.
   */
  async remover(id: number, userId: number): Promise<ResultadoBusqueda> {
    const remote = await this.remotes.findOne({
      where: { id },
      relations: { model: true },
    });
    if (!remote) throw new NotFoundException(`No existe el control ${id}`);
    if (remote.removedAt !== null) {
      throw new ConflictException('Ese control ya está removido');
    }

    const antes = {
      serial: remote.serial,
      status: remote.status,
      homeId: remote.homeId,
    };

    remote.removedAt = new Date();
    remote.removedBy = userId;
    // Vuelve al stock: `chk_remote_custody` exige que todo lo que no está en
    // INVENTORY tenga vivienda, así que desvincular y cambiar el estado son la
    // misma operación, no dos.
    remote.homeId = null;
    remote.assignedToUserId = null;
    remote.status = RemoteStatus.INVENTORY;
    remote.updatedBy = userId;

    const guardado = await this.remotes.save(remote);

    await this.audit.record({
      actorUserId: userId,
      action: 'remote.remove',
      entityType: 'remote',
      entityId: id,
      oldValue: antes,
    });

    return this.armarResultado(guardado, 'serial', null);
  }

  /**
   * De vuelta a circulación, al STOCK DE FÁBRICA.
   *
   * Vuelve SIN el visto bueno aunque lo tuviera: pasó por la papelera, así que
   * alguien tiene que mirarlo de nuevo —que los códigos sigan grabados, que la
   * etiqueta esté legible— antes de que se lo pueda entregar. Es el mismo
   * criterio que el claim code nuevo del equipo restaurado.
   */
  async restaurar(id: number, userId: number): Promise<ResultadoBusqueda> {
    const remote = await this.remotes.findOne({
      where: { id },
      relations: { model: true },
    });
    if (!remote) throw new NotFoundException(`No existe el control ${id}`);
    if (remote.removedAt === null) {
      throw new ConflictException('Ese control no está removido');
    }

    remote.removedAt = null;
    remote.removedBy = null;
    remote.readyAt = null;
    remote.readyBy = null;
    // Código nuevo: el anterior quedó impreso en una etiqueta que puede andar
    // dando vueltas, y con ella cualquiera podría reclamar el control.
    remote.claimCode = generarClaimCode();
    remote.updatedBy = userId;

    const guardado = await this.remotes.save(remote);

    await this.audit.record({
      actorUserId: userId,
      action: 'remote.restore',
      entityType: 'remote',
      entityId: id,
      newValue: { serial: remote.serial },
    });

    return this.armarResultado(guardado, 'serial', null);
  }

  /**
   * BORRADO DEFINITIVO. Solo desde la papelera.
   *
   * Se lleva puestos los códigos (`remote_code` es ON DELETE CASCADE), y eso
   * tiene una consecuencia deliberada: **esos códigos vuelven a quedar
   * disponibles**. El índice único vive sobre `code_hmac`, así que al irse las
   * filas se va la reserva y otro control puede recibirlos.
   *
   * Los EVENTOS no se van: `event.remote_id` es ON DELETE RESTRICT porque son
   * append-only. Un control que ya disparó una alarma no se puede borrar, y el
   * error lo dice en vez de mostrar una violación de clave foránea.
   */
  async borrarDefinitivo(
    id: number,
    userId: number,
  ): Promise<{ mensaje: string }> {
    const remote = await this.remotes.findOne({ where: { id } });
    if (!remote) throw new NotFoundException(`No existe el control ${id}`);
    if (remote.removedAt === null) {
      throw new ConflictException(
        'Primero remové el control. El borrado definitivo solo se hace desde la papelera.',
      );
    }

    // El audit_log va ANTES del borrado: `entity_id` no tiene FK, así que la
    // fila sobrevive al control y queda el rastro de qué serial se borró.
    await this.audit.record({
      actorUserId: userId,
      action: 'remote.hard_delete',
      entityType: 'remote',
      entityId: id,
      oldValue: { serial: remote.serial, modelId: remote.modelId },
    });

    try {
      await this.remotes.delete(id);
    } catch (e) {
      if (esViolacionDeClaveForanea(e)) {
        throw new ConflictException(
          `No se puede borrar ${remote.serial}: tiene eventos registrados, y los ` +
            'eventos no se borran nunca. El control se queda en removidos.',
        );
      }
      throw e;
    }

    return { mensaje: `Se borró ${remote.serial} definitivamente.` };
  }

  /**
   * Buscar un control por número de serie o por uno de sus códigos.
   *
   * La búsqueda por CÓDIGO existe gracias al HMAC que se agregó para la
   * unicidad: es determinístico, así que un código conocido se convierte en la
   * misma huella y se encuentra con un índice, **sin descifrar nada**. Sobre la
   * columna cifrada esto sería imposible — el IV aleatorio hace que el mismo
   * código guardado dos veces no se parezca ni a sí mismo.
   *
   * Y solo encuentra con el código COMPLETO y exacto: no hay forma de buscar
   * "los que empiezan con 5000" ni de enumerar. Quien busca ya tiene el número
   * —lo leyó de la etiqueta o de un log— y lo que averigua es de qué control es.
   *
   * Un texto que sea todo dígitos se busca por las dos puntas: puede ser un
   * código o el número de un serial, y adivinar cuál quiso decir el operario
   * sería peor que mostrarle los dos.
   */
  async buscar(texto: string): Promise<ResultadoBusqueda[]> {
    const q = texto.trim();
    if (q.length === 0) return [];

    const porSerial = await this.remotes.find({
      where: { serial: ILike(`%${q}%`) },
      relations: { model: true },
      order: { serial: 'ASC' },
      take: 25,
    });

    const encontrados = new Map<number, ResultadoBusqueda>(
      porSerial.map((r) => [r.id, this.armarResultado(r, 'serial', null)]),
    );

    // Solo si puede ser un código: un HMAC de "CR-12" no le sirve a nadie.
    const numero = Number(q);
    if (codigoValido(numero)) {
      const [fila] = await this.dataSource
        .getRepository(RemoteCode)
        .createQueryBuilder('c')
        .select(['c.remote_id AS remote_id', 'c.position AS position'])
        .where('c.code_hmac = :hmac', {
          hmac: this.crypto.fingerprint(String(numero)),
        })
        .getRawMany<{ remote_id: number; position: number }>();

      if (fila) {
        const remote = await this.remotes.findOne({
          where: { id: fila.remote_id },
          relations: { model: true },
        });
        if (remote) {
          // Si ya vino por serial, gana "código": es la coincidencia más fuerte
          // y la que explica por qué apareció.
          encontrados.set(
            remote.id,
            this.armarResultado(remote, 'codigo', fila.position),
          );
        }
      }
    }

    return [...encontrados.values()];
  }

  private armarResultado(
    remote: Remote,
    coincidePor: 'serial' | 'codigo',
    position: number | null,
  ): ResultadoBusqueda {
    return {
      id: remote.id,
      serial: remote.serial,
      status: remote.status,
      homeId: remote.homeId,
      modelo: remote.model
        ? {
            id: remote.model.id,
            code: remote.model.code,
            name: remote.model.name,
            buttons: remote.model.buttons,
          }
        : null,
      coincidePor,
      // El visto bueno de fábrica: hasta que no está, el control no sale.
      readyAt: remote.readyAt?.toISOString() ?? null,
      removedAt: remote.removedAt?.toISOString() ?? null,
      // Qué botón es el código buscado. No se devuelve el código: quien busca
      // ya lo tiene, y devolverlo sería un camino de lectura sin auditar.
      position,
      boton: position === null ? null : this.botonDe(position).boton,
    };
  }

  /**
   * Los datos de la etiqueta, con los códigos EN CLARO.
   *
   * Solo CPS y siempre auditado, igual que revelar un código suelto. La etiqueta
   * lleva los 4 códigos en el QR por decisión explícita (2026-08-05), y eso
   * significa que una foto de la etiqueta alcanza para clonar el control: el
   * panel no valida nada más que el número, así que quien lo tenga puede
   * disparar —y con la posición 4, APAGAR— la alarma del barrio.
   *
   * Como el riesgo se aceptó, lo que queda es la trazabilidad: si aparece un
   * control clonado, el `audit_log` dice quién imprimió esa etiqueta y cuándo.
   */
  async etiqueta(id: number, userId: number): Promise<EtiquetaControl> {
    const remote = await this.remotes.findOne({
      where: { id },
      relations: { model: true },
    });
    if (!remote) throw new NotFoundException(`No existe el control ${id}`);
    if (!remote.serial || !remote.model) {
      throw new ConflictException(
        'Este control es anterior a la fábrica: no tiene serial ni modelo, así que no se le puede imprimir una etiqueta',
      );
    }

    const filas = await this.dataSource
      .getRepository(RemoteCode)
      .createQueryBuilder('c')
      .select(['c.position AS position'])
      .addSelect('c.code_encrypted', 'code_encrypted')
      .where('c.remote_id = :id', { id })
      .orderBy('c.position', 'ASC')
      .getRawMany<{ position: number; code_encrypted: Buffer }>();

    await this.audit.record({
      actorUserId: userId,
      // No se llama `label_print`: el backend entrega los códigos y no tiene
      // forma de saber si el navegador llegó a imprimir. Lo que sí pasó, y es
      // lo que hay que auditar, es que alguien los vio.
      action: 'remote.codes_reveal',
      entityType: 'remote',
      entityId: id,
      metadata: { serial: remote.serial },
    });

    return {
      id: remote.id,
      serial: remote.serial,
      claimCode: remote.claimCode,
      modelo: {
        id: remote.model.id,
        code: remote.model.code,
        name: remote.model.name,
        buttons: remote.model.buttons,
      },
      codigos: filas.map((f) => {
        const codigo = Number(this.crypto.decrypt(f.code_encrypted));
        return {
          ...this.botonDe(f.position),
          codigo: codigoValido(codigo) ? codigo : 0,
        };
      }),
    };
  }
}
