import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

/**
 * FÁBRICA: el ingreso de cosas al sistema, con sus dos familias adentro.
 *
 * Es el único lugar donde alarmas y controles conviven en pestañas, y tiene
 * sentido que sea acá: fabricar es el mismo trabajo para los dos —una estación,
 * una tanda, una etiqueta— y quien está en la mesa pasa de una a la otra.
 *
 * En INVENTARIO, en cambio, cada familia tiene su propia pantalla: ahí las
 * preguntas son distintas (a qué barrio va una alarma, a qué vivienda va un
 * control) y mezclarlas obligaba a saltar entre pestañas que no tenían nada que
 * ver con lo que se estaba mirando.
 */
@Component({
  selector: 'app-factory-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  template: `
    <div class="mb-3">
      <h2 class="h5 fw-bold mb-0"><i class="icon-cpu text-brand me-2"></i>Fábrica</h2>
      <p class="text-muted small mb-0">
        El ingreso de equipos y controles al sistema. La entrega a un cliente y la
        instalación son pasos posteriores, en Inventario.
      </p>
    </div>

    <ul class="nav nav-tabs mb-4">
      <li class="nav-item">
        <a
          class="nav-link"
          routerLink="/inventario/fabrica/alarmas"
          routerLinkActive="active"
          title="Alta de alarmas desde la MAC"
        >
          <i class="icon-radio-tower me-1"></i> Alarmas
        </a>
      </li>
      <li class="nav-item">
        <a
          class="nav-link"
          routerLink="/inventario/fabrica/controles"
          routerLinkActive="active"
          title="Alta de controles remotos"
        >
          <i class="icon-key me-1"></i> Controles
        </a>
      </li>
    </ul>

    <router-outlet />
  `,
})
export class FactoryShell {}
