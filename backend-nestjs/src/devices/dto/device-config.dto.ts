import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

/**
 * El patch que se publica.
 *
 * Es un objeto libre A PROPÓSITO: las secciones válidas las define el firmware y
 * el merge lo hace `gtd.publish_config` contra el espejo, que es lo único que
 * sabe qué está corriendo el panel. Los rangos los valida `validarPatch`
 * (`device-config.limits.ts`) antes de llamar a la función.
 *
 * Mandar solo lo que cambia no es una optimización: cada byte cuenta contra los
 * 1024 del buffer de entrada del panel.
 */
export class PublishConfigDto {
  @ApiProperty({
    description:
      'Patch de configuración. Solo las secciones que cambian; el resto lo toma del espejo.',
    example: { tiempos: { send_tele_s: 300 }, modulos: { rf: true } },
  })
  @IsObject()
  patch!: Record<string, unknown>;
}

/**
 * Una red del equipo, SIN la password.
 *
 * El GET nunca las devuelve: se dice que hay una guardada, no cuál es. El único
 * camino de lectura es `/config/reveal-wifi`, solo-CPS y auditado.
 */
export interface RedWifiView {
  ssid: string;
  prio: number;
  tienePassword: boolean;
  /**
   * El panel la puso en su lista negra permanente y NO la va a usar, esté
   * cargada o no. Sin mostrarlo, una red bien tipeada y con la clave correcta
   * simplemente no conecta y no hay nada en pantalla que lo explique. Se limpia
   * con `cmd t:red op:bl_clear`, que todavía no está expuesto.
   */
  bloqueada: boolean;
}

/** Una red vista en el último scan del equipo. */
export interface ScanRedView {
  ssid: string;
  rssi: number;
  seg: boolean;
  ch: number;
  /** El panel ya la tiene en sus credenciales guardadas. */
  guardada: boolean;
}

export interface ScanView {
  redes: ScanRedView[];
  recibidoEn: string;
}

/**
 * Estado de la publicación. DERIVADO, no hay columna que lo guarde: `verified`
 * es `config_espejo.cfg_v >= panel_config.cfg_v`, y guardarlo sería un segundo
 * lugar donde vive el mismo hecho, libre de contradecir al espejo.
 */
export type EstadoConfig =
  /** El equipo nunca reportó su cfg_full: no se puede editar sin espejo. */
  | 'SIN_ESPEJO'
  /** Lo que corre el panel coincide con lo último que mandamos. */
  | 'VERIFICADO'
  /** Encolada, el GtD todavía no la publicó. */
  | 'PENDIENTE'
  /** Publicada en el broker, sin ack todavía. */
  | 'ENVIADA'
  /** El panel ackeó, pero el espejo todavía no volvió: no sabemos qué quedó. */
  | 'APLICADA_SIN_VERIFICAR'
  /** No se pudo entregar. `detalle` dice por qué. */
  | 'FALLIDA'
  /**
   * El equipo volvió a los valores de fábrica (`factory`): reportó `cfg_v = 0` y
   * `upsert_panel_state` marcó la cola en `stale`.
   *
   * Es el único estado en el que **el espejo no es lo que está corriendo**: como
   * `upsert_config_espejo` no se deja pisar por una versión más vieja, la web
   * conserva la configuración anterior mientras el panel corre los defaults. Sin
   * este caso, la comparación `espejo.cfg_v >= cola.cfg_v` daba VERIFICADO y la
   * pantalla afirmaba estar mostrando lo que el equipo tiene.
   */
  | 'DESACTUALIZADA';

export interface DeviceConfigView {
  deviceId: number;
  estado: EstadoConfig;
  /** El espejo sin las redes (van aparte, ya saneadas). null si no hay espejo. */
  configuracion: Record<string, unknown> | null;
  redes: RedWifiView[];
  /** `bigint` en Postgres: viaja como string para no perder precisión. */
  cfgVEspejo: string | null;
  cfgVPendiente: string | null;
  /** Por qué no se pudo entregar, cuando estado = FALLIDA. */
  detalle: string | null;
  espejoActualizadoEn: string | null;
  ultimoScan: ScanView | null;
  /**
   * Si este usuario puede publicar configuración en este equipo. Son los DOS
   * ejes: el rol dice QUÉ (el MONITOR mira y no configura) y la membresía dice
   * DÓNDE (`managesNeighborhood`: con `managed_by = CPS` la organización mira).
   *
   * Tiene que responder exactamente lo mismo que el `PUT`. Con solo el segundo
   * eje, el MONITOR recibía el formulario habilitado y se comía un 403 recién
   * al apretar Guardar.
   */
  puedeEditar: boolean;
  /** Si puede pedir las contraseñas WiFi en claro (solo CPS, auditado). */
  puedeVerPasswords: boolean;
}

/**
 * Un equipo del mismo barrio del que se puede copiar la configuración.
 *
 * Solo aparecen los que ya reportaron su `cfg_full`: de uno sin espejo no hay
 * nada que copiar.
 */
export interface FuenteConfigView {
  deviceId: number;
  nombre: string;
  serial: string;
  espejoActualizadoEn: Date;
}

/** Una red con su password en claro. Solo sale por `/config/reveal-wifi`. */
export interface RedWifiRevelada {
  ssid: string;
  psw: string;
}
