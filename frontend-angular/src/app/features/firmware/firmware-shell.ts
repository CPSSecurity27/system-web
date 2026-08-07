import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

/**
 * ACTUALIZACIONES: el catálogo de firmwares y el gestor de la flota.
 *
 * Sección propia y no una pestaña de Inventario: no es stock ni fabricación. Un
 * firmware no entra al sistema como entra un equipo —no se cuenta, no se
 * entrega, no se instala en un poste— y lo que se hace acá es decidir qué
 * software corre la infraestructura.
 *
 * Dos pestañas porque son dos trabajos distintos y en dos momentos distintos:
 * primero se publica una versión (de a una, con cuidado), y después —quizás
 * días después— se decide a qué postes mandarla.
 */
@Component({
  selector: 'app-firmware-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  template: `
    <div class="mb-3">
      <h2 class="h5 fw-bold mb-0">
        <i class="icon-refresh-cw text-brand me-2"></i>Actualizaciones
      </h2>
      <p class="text-muted small mb-0">
        Qué firmware está publicado y qué versión corre cada poste.
      </p>
    </div>

    <ul class="nav nav-tabs mb-4">
      <li class="nav-item">
        <a
          class="nav-link"
          routerLink="/actualizaciones/versiones"
          routerLinkActive="active"
          title="Subir un .bin y publicarlo"
        >
          <i class="icon-package me-1"></i> Versiones
        </a>
      </li>
      <li class="nav-item">
        <a
          class="nav-link"
          routerLink="/actualizaciones/equipos"
          routerLinkActive="active"
          title="Qué versión corre cada equipo"
        >
          <i class="icon-radio-tower me-1"></i> Equipos
        </a>
      </li>
    </ul>

    <router-outlet />
  `,
})
export class FirmwareShell {}
