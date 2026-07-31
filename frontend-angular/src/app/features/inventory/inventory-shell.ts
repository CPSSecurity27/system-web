import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { AuthService } from '../../core/auth/auth.service';

/**
 * Contenedor de la sección Inventario: encabezado + sub-pestañas y el
 * router-outlet donde entra cada vista hija.
 *
 * Inventario responde UNA pregunta: "¿qué equipos tengo y en qué punto de su
 * ciclo de vida están?". Es la mirada LOGÍSTICA (fabricar, stock, entregar el
 * lote, reclamar). La mirada OPERATIVA — qué alarmas hay funcionando en un
 * barrio — vive aparte, en /alarmas y en el detalle del barrio: es el mismo
 * objeto respondiendo otra pregunta y para otra audiencia.
 *
 * Por eso la sección entera es de gestión (managerGuard, en las rutas): un
 * vecino o un monitorista no tienen nada que hacer acá.
 */
@Component({
  selector: 'app-inventory-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './inventory-shell.html',
})
export class InventoryShell {
  protected readonly auth = inject(AuthService);
}
