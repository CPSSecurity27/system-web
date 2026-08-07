import { MotivoSalteo } from '../rf-sync';

/** Un control en la lista de la pantalla. `dni` es el del portador. */
export interface ControlDeSync {
  remoteId: number;
  serial: string | null;
  direccion: string;
  portador: string | null;
  dni: string | null;
}

export interface ControlSalteado extends ControlDeSync {
  motivo: MotivoSalteo;
  /** El motivo en castellano, listo para mostrar. */
  explicacion: string;
}

/** Una baja: lo que hay que sacar del equipo. Puede no tener control vivo. */
export interface BajaDeSync {
  dni: string;
  serial: string | null;
  /** Por qué sobra: "volvió al stock", "se reportó perdido", "cambió de dueño". */
  motivo: string;
}

/** La tanda en curso o la última que terminó. */
export interface TandaDeSync {
  batchId: string;
  total: number;
  hechos: number;
  /** `en_curso` | `terminada` | `con_error` */
  estado: 'en_curso' | 'terminada' | 'con_error';
  /** El detalle del ack que la cortó, ya traducido. */
  detalle: string | null;
  empezada: string;
}

/**
 * Un control del barrio que NO le toca a ningún equipo.
 *
 * Su vivienda no tiene alarma preferida, así que no entra en el plan de ningún
 * panel: el vecino tiene el llavero y ninguna alarma lo conoce. Pasa siempre que
 * la casa se cargó ANTES de que el barrio tuviera alarmas —el combo del alta
 * estaba vacío— y no se avisaba en ningún lado.
 */
export interface ControlSinAlarma {
  remoteId: number;
  serial: string | null;
  homeId: number;
  direccion: string;
}

/**
 * Lo que ve la pantalla de Configuración del equipo.
 *
 * `alDia` es un número y no una lista a propósito: lo que hay que mirar es lo
 * que FALTA. Los que ya están cargados no piden ninguna decisión.
 */
export interface EstadoRfView {
  /**
   * Controles del MISMO BARRIO cuya vivienda no eligió alarma preferida.
   *
   * No son de este equipo —no son de ninguno— pero se muestran acá porque esta
   * es la pantalla donde alguien se pregunta "¿por qué no aparece el control que
   * acabo de asignar?". Sin esto, la respuesta es un cero sin explicación.
   */
  sinAlarma: ControlSinAlarma[];
  /** Cuántos vecinos entran en el chip y cuántos ocuparía la sincronización. */
  capacidad: { tope: number; ocupados: number };
  alDia: number;
  pendientes: ControlDeSync[];
  bajas: BajaDeSync[];
  salteados: ControlSalteado[];
  tanda: TandaDeSync | null;
  /** Rol + alcance + el equipo instalado y con MAC. La pantalla no adivina. */
  puedeSincronizar: boolean;
  /** Por qué no se puede, si no se puede. */
  impedimento: string | null;
}
