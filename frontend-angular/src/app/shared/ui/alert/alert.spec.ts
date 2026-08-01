import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { Alert, AlertVariant } from './alert';

@Component({
  imports: [Alert],
  template: `<cps-alert [variant]="variant" [dense]="dense">Algo pasó</cps-alert>`,
})
class Host {
  variant: AlertVariant = 'info';
  dense = false;
}

const render = (variant: AlertVariant, dense = false) => {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.variant = variant;
  fixture.componentInstance.dense = dense;
  fixture.detectChanges();
  return fixture.nativeElement.querySelector('.alert') as HTMLElement;
};

describe('cps-alert', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
  });

  it('proyecta el contenido', () => {
    expect(render('info').textContent).toContain('Algo pasó');
  });

  it('el error usa el tono de marca', () => {
    const el = render('error');
    expect(el.className).toContain('bg-brand-soft');
    expect(el.className).toContain('text-brand');
  });

  it('cada variante tiene su tono', () => {
    expect(render('warning').className).toContain('bg-warning-soft');
    expect(render('success').className).toContain('bg-success-soft');
    expect(render('info').className).toContain('bg-light');
  });

  it('cada variante tiene su ícono', () => {
    const icon = (v: AlertVariant) => (render(v).querySelector('i') as HTMLElement).className;
    expect(icon('error')).toContain('bi-exclamation-triangle-fill');
    expect(icon('warning')).toContain('bi-exclamation-circle');
    expect(icon('success')).toContain('bi-check-circle');
    expect(icon('info')).toContain('bi-info-circle');
  });

  it('dense achica el bloque', () => {
    expect(render('info', true).className).toContain('py-2');
    expect(render('info', true).className).toContain('small');
    expect(render('info', false).className).not.toContain('py-2');
  });

  it('tiene rol de alerta para lectores de pantalla', () => {
    expect(render('error').getAttribute('role')).toBe('alert');
  });
});
