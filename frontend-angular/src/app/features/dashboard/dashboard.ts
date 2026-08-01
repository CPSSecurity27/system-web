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
        // El stock: acá está el RECLAMO con el que se instalan las alarmas.
        route: '/inventario/stock',
        icon: 'bi-box-seam',
        title: 'Inventario',
        description: 'Los equipos que todavía no están en servicio',
        visible: this.auth.isManager(),
      },
      {
        /**
         * "Contratos" dejó de ser pantalla propia (2026-07-31): el contrato es
         * de la CUENTA y vive en su ficha. Para el cliente, esa ficha es Mi
         * organización — /clientes es solo-CPS y lo rebotaría.
         */
        route: '/mi-organizacion',
        icon: 'bi-building',
        title: 'Mi organización',
        description: 'Su contrato, sus cupos y su gente',
        visible: this.auth.isOrgManager(),
      },
      {
        route: '/clientes',
        icon: 'bi-briefcase-fill',
        title: 'Clientes',
        description: 'Organizaciones municipales y comunitarias, con sus cupos',
        visible: this.auth.isCps(),
      },
      {
        route: '/usuarios',
        icon: 'bi-people-fill',
        title: 'Usuarios',
        description: 'El padrón de personas del sistema',
        visible: this.auth.isCps(),
      },
      {
        route: '/empresa/personal',
        icon: 'bi-person-badge-fill',
        title: 'Personal de CPS',
        description: 'Quién trabaja en CPS y con qué rol',
        visible: this.auth.isCps(),
      },
      {
        route: '/empresa/planes',
        icon: 'bi-tags-fill',
        title: 'Planes',
        description: 'El catálogo comercial: qué cupos otorga cada plan',
        visible: this.auth.isCps(),
      },
    ].filter((card) => card.visible),
  );
}
