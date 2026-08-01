import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { PageHeader } from './page-header';

@Component({
  imports: [PageHeader],
  template: `
    <cps-page-header [title]="title" [subtitle]="subtitle" [icon]="icon">
      <button actions type="button">Registrar evento</button>
    </cps-page-header>
  `,
})
class Host {
  title = 'Eventos';
  subtitle = 'El tablero del monitoreo';
  icon = 'bi-bell-fill';
}

const render = () => {
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
};

describe('cps-page-header', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
  });

  it('muestra el título como encabezado', () => {
    const h = render().querySelector('h2') as HTMLElement;
    expect(h.textContent).toContain('Eventos');
  });

  it('muestra el subtítulo', () => {
    expect(render().textContent).toContain('El tablero del monitoreo');
  });

  it('muestra el ícono cuando hay uno', () => {
    expect((render().querySelector('h2 i') as HTMLElement).className).toContain('bi-bell-fill');
  });

  it('proyecta las acciones', () => {
    expect(render().querySelector('button[actions]')?.textContent).toContain('Registrar evento');
  });

  it('sin subtítulo no deja el párrafo vacío', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.subtitle = '';
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('p')).toBeNull();
  });

  it('sin ícono no deja el <i> vacío', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.icon = '';
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('h2 i')).toBeNull();
  });
});
