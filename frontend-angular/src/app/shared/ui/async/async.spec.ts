import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { Async } from './async';

@Component({
  imports: [Async],
  template: `
    <cps-async
      [loading]="loading"
      [empty]="empty"
      loadingText="Cargando eventos…"
      emptyText="No hay eventos para mostrar."
      emptyIcon="bi-bell-slash"
    >
      <table id="contenido"></table>
    </cps-async>
  `,
})
class Host {
  loading = false;
  empty = false;
}

const render = (loading: boolean, empty: boolean) => {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.loading = loading;
  fixture.componentInstance.empty = empty;
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
};

describe('cps-async', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
  });

  it('cargando: muestra el spinner y su texto, y NO el contenido', () => {
    const el = render(true, false);
    expect(el.querySelector('.spinner-border')).not.toBeNull();
    expect(el.textContent).toContain('Cargando eventos…');
    expect(el.querySelector('#contenido')).toBeNull();
  });

  it('vacío: muestra el texto y el ícono, y NO el contenido', () => {
    const el = render(false, true);
    expect(el.textContent).toContain('No hay eventos para mostrar.');
    expect((el.querySelector('.text-center i') as HTMLElement).className).toContain(
      'bi-bell-slash',
    );
    expect(el.querySelector('#contenido')).toBeNull();
  });

  it('con datos: muestra el contenido y nada más', () => {
    const el = render(false, false);
    expect(el.querySelector('#contenido')).not.toBeNull();
    expect(el.querySelector('.spinner-border')).toBeNull();
    expect(el.textContent).not.toContain('No hay eventos');
  });

  it('cargando gana sobre vacío: una lista vacía mientras carga no es "no hay nada"', () => {
    const el = render(true, true);
    expect(el.querySelector('.spinner-border')).not.toBeNull();
    expect(el.textContent).not.toContain('No hay eventos');
  });
});
