import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AuthService } from '../../core/auth/auth.service';

interface DashboardCard {
  route: string;
  icon: string;
  title: string;
  description: string;
  visible: boolean;
}

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink],
  templateUrl: './dashboard.html',
})
export class Dashboard {
  protected readonly auth = inject(AuthService);

  /**
   * Qué se le ofrece a cada quien. Se decide con el par (tipo de cuenta, rol);
   * el vecino se reconoce por sus membresías de HOGAR, no por cuentas.
   *
   * Esto NO es la seguridad (el backend rechaza igual): es no ofrecer puertas
   * que dan a un 403 o a una pantalla vacía.
   */
  protected readonly cards = computed<DashboardCard[]>(() =>
    [
      {
        route: '/eventos',
        icon: 'bi-bell-fill',
        title: 'Eventos',
        description: 'El tablero del monitoreo: activaciones y su resolución',
        visible: true,
      },
      {
        route: '/barrios',
        icon: 'bi-houses-fill',
        title: 'Barrios',
        // v2: el vecino también ve SU barrio (llega por homeMemberships).
        description: 'Los barrios bajo monitoreo',
        visible: true,
      },
      {
        route: '/viviendas',
        icon: 'bi-house-door-fill',
        title: 'Viviendas',
        description: 'Las casas del barrio y sus miembros',
        visible: true,
      },
      {
        route: '/alarmas',
        icon: 'bi-broadcast-pin',
        title: 'Sirenas / Alarmas',
        description: 'Los postes instalados en la vía pública',
        visible: true,
      },
      {
        route: '/controles',
        icon: 'bi-key-fill',
        title: 'Controles remotos',
        description: 'Quién lleva cada control encima',
        visible: true,
      },
      {
        route: '/contratos',
        icon: 'bi-file-earmark-text-fill',
        title: 'Contratos',
        description: 'Lo comercial: organización → barrio',
        visible: this.auth.isManager(),
      },
      {
        route: '/cuentas',
        icon: 'bi-briefcase-fill',
        title: 'Cuentas',
        description: 'Municipios y comunidades clientes, con sus cupos',
        visible: this.auth.isCps(),
      },
      {
        route: '/usuarios',
        icon: 'bi-people-fill',
        title: 'Usuarios',
        description: 'El padrón de personas del sistema',
        visible: this.auth.isCps(),
      },
    ].filter((card) => card.visible),
  );
}
