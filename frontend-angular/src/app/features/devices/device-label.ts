import { Component, computed, effect, input, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { inject } from '@angular/core';
import QRCode from 'qrcode';

import { Device } from '../../core/models/api.models';

/**
 * La etiqueta física del equipo: 90 × 45 mm, blanco y negro.
 *
 * Se imprime con `window.print()` y `@page` — no hay servicio de impresión ni
 * PDF. Las medidas están en milímetros a propósito: es un objeto que se pega a
 * un poste, no una pantalla, y en px habría que recalcular todo por cada DPI.
 *
 * ## Qué lleva y por qué
 *
 * Arriba la identidad (marca, serial, número de placa). Abajo, dos mitades con
 * un QR cada una en bordes OPUESTOS: dos QR pegados se pisan y la cámara agarra
 * el que quiere. Cada uno rotulado —WIFI y APP— porque no se distinguen mirando.
 *
 *   Izquierda  conectarse al equipo: QR de red abierta + SSID escrito + las
 *              credenciales del portal.
 *   Derecha    darlo de alta: QR con serial y claim code + el código escrito.
 *
 * El SSID va escrito COMPLETO además del QR: si el QR no lee —etiqueta rayada,
 * celular viejo— el técnico tiene que poder tipear la red a mano.
 *
 * ## Lo que NUNCA va
 *
 * La password del usuario `cps`. El firmware es explícito: es la credencial de
 * nivel fábrica y jamás se imprime. Este componente ni siquiera la recibe.
 */
@Component({
  selector: 'app-device-label',
  imports: [],
  templateUrl: './device-label.html',
  styleUrl: './device-label.css',
})
export class DeviceLabel {
  readonly device = input.required<Device>();

  private readonly sanitizer = inject(DomSanitizer);

  protected readonly qrWifi = signal<SafeHtml | null>(null);
  protected readonly qrApp = signal<SafeHtml | null>(null);

  protected readonly portal = computed(() => this.device().portal);

  constructor() {
    // Los QR se generan de forma asincrónica: el efecto los rehace cada vez que
    // cambia el equipo, así que reimprimir otro no arrastra el anterior.
    effect(() => {
      const portal = this.device().portal;
      if (!portal) {
        this.qrWifi.set(null);
        this.qrApp.set(null);
        return;
      }
      void this.dibujar(portal.qrWifi, this.qrWifi);
      void this.dibujar(portal.qrApp, this.qrApp);
    });
  }

  private async dibujar(
    texto: string,
    destino: ReturnType<typeof signal<SafeHtml | null>>,
  ): Promise<void> {
    const svg = await QRCode.toString(texto, {
      type: 'svg',
      // Sin margen: el silencio alrededor lo da el CSS, y el `margin` de la
      // librería se come milímetros que en 16 mm de QR se notan.
      margin: 0,
      // M es el nivel que recomienda el doc del firmware para el QR de red.
      // Más corrección = más módulos = módulos más chicos a igual tamaño físico,
      // que en una térmica de 203 dpi es peor negocio que la redundancia.
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    });
    destino.set(this.sanitizer.bypassSecurityTrustHtml(svg));
  }
}
