import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { Status } from './status';
import { lookOf } from './status-map';

@Component({
  imports: [Status],
  template: `<cps-status kind="event" [value]="value" />`,
})
class Host {
  value = 'OPEN';
}

const render = (value: string) => {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.value = value;
  fixture.detectChanges();
  return fixture.nativeElement.querySelector('.badge') as HTMLElement;
};

describe('lookOf', () => {
  it('traduce los tres estados de un evento', () => {
    expect(lookOf('event', 'OPEN').label).toBe('Abierto');
    expect(lookOf('event', 'RESOLVED').label).toBe('Resuelto');
    expect(lookOf('event', 'FALSE_ALARM').label).toBe('Falsa alarma');
  });

  it('un valor desconocido se muestra tal cual en vez de romper', () => {
    expect(lookOf('event', 'LO_QUE_SEA').label).toBe('LO_QUE_SEA');
  });
});

describe('cps-status', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
  });

  it('renderiza la etiqueta traducida', () => {
    expect(render('OPEN').textContent).toContain('Abierto');
  });

  it('el abierto usa el tono de marca', () => {
    expect(render('OPEN').className).toContain('bg-brand-soft');
  });

  it('el resuelto usa el tono de éxito', () => {
    expect(render('RESOLVED').className).toContain('bg-success-soft');
  });

  it('la falsa alarma queda apagada', () => {
    expect(render('FALSE_ALARM').className).toContain('text-muted');
  });
});
