import { Component, effect, inject, input, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import QRCode from 'qrcode';

import { EtiquetaControl } from '../../core/models/api.models';

/**
 * La etiqueta física del control remoto: 40 × 20 mm, blanco y negro.
 *
 * Mucho más chica que la del equipo (90 × 45) por una razón obvia: esto se pega
 * a un llavero, no a un gabinete montado en un poste. En milímetros y no en px,
 * por lo mismo que la otra: es un objeto, no una pantalla.
 *
 * **Solo dibuja.** El disparo de `window.print()` lo hace la pantalla de
 * fábrica, igual que con la etiqueta del equipo: es la que sabe cuándo el QR ya
 * entró al DOM y la que tiene el resto del contexto.
 *
 * ## Qué lleva
 *
 * El **serial** escrito grande —es lo que se busca en una caja de cincuenta— y
 * un QR con serial, modelo y **los cuatro códigos RF**.
 *
 * ## Lo que hay que saber del QR
 *
 * Los códigos van EN CLARO, por decisión explícita (2026-08-05). El costo está
 * asumido y conviene tenerlo escrito: el panel no valida nada más que el número
 * de 64 bits, así que **una foto de esta etiqueta alcanza para clonar el
 * control** — y con el código de la posición 4, para APAGAR la alarma del
 * barrio. Por eso pedir los datos de la etiqueta es solo-CPS y queda en
 * `audit_log`.
 *
 * Los códigos van además ESCRITOS abajo del QR. Son el dato que hay que grabar
 * en el control: si el QR no lee, el operario tiene que poder tipearlos.
 */
@Component({
  selector: 'app-remote-label',
  imports: [],
  templateUrl: './remote-label.html',
  styleUrl: './remote-label.css',
})
export class RemoteLabel {
  readonly etiqueta = input.required<EtiquetaControl>();

  private readonly sanitizer = inject(DomSanitizer);

  protected readonly qr = signal<SafeHtml | null>(null);

  constructor() {
    // Se rehace cada vez que cambia el control, así imprimir otro no arrastra
    // el QR del anterior.
    effect(() => {
      void this.dibujar(this.etiqueta());
    });
  }

  /**
   * El contenido del QR. Formato propio, corto y explícito.
   *
   * Corto importa: cada carácter son más módulos, y en 14 mm de lado los módulos
   * ya son del tamaño del punto de una térmica de 203 dpi. Por eso no es JSON —
   * las comillas y las llaves serían un tercio del contenido sin agregar nada.
   */
  private contenido(datos: EtiquetaControl): string {
    const codigos = datos.codigos
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((c) => c.codigo)
      .join(',');
    // El código de reclamo entra en el QR: es con lo que un cliente suma el
    // control a su stock escaneando, sin tipear nada.
    return `CPS-CR|${datos.serial}|${datos.modelo.code}|${datos.claimCode ?? ''}|${codigos}`;
  }

  private async dibujar(datos: EtiquetaControl): Promise<void> {
    if (!datos) {
      this.qr.set(null);
      return;
    }
    const svg = await QRCode.toString(this.contenido(datos), {
      type: 'svg',
      margin: 0,
      // Q y no M: esta etiqueta va en un llavero, que se raya, se moja y se
      // frota contra las llaves. Más redundancia vale el módulo más chico.
      errorCorrectionLevel: 'Q',
      color: { dark: '#000000', light: '#ffffff' },
    });
    this.qr.set(this.sanitizer.bypassSecurityTrustHtml(svg));
  }
}
