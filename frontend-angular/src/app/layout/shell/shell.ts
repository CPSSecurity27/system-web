import { Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { AuthService } from '../../core/auth/auth.service';

const SIDEBAR_COLLAPSED_KEY = 'cps.sidebarCollapsed';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell {
  protected readonly auth = inject(AuthService);

  protected readonly collapsed = signal(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1');

  protected toggleSidebar(): void {
    this.collapsed.update((v) => !v);
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, this.collapsed() ? '1' : '0');
  }

  protected logout(): void {
    this.auth.logout().subscribe();
  }
}
