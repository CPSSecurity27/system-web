import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { Paginator } from './paginator';

@Component({
  imports: [Paginator],
  template: `
    <cps-paginator
      [offset]="offset"
      [count]="count"
      [total]="total"
      [disabled]="disabled"
      (prev)="movimientos.push('prev')"
      (next)="movimientos.push('next')"
    />
  `,
})
class Host {
  offset = 0;
  count = 20;
  total = 45;
  disabled = false;
  movimientos: string[] = [];
}

const setup = (over: Partial<Host> = {}) => {
  const fixture = TestBed.createComponent(Host);
  Object.assign(fixture.componentInstance, over);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const [prev, next] = Array.from(el.querySelectorAll('button')) as HTMLButtonElement[];
  return { fixture, el, prev, next, host: fixture.componentInstance };
};

describe('cps-paginator', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
  });

  it('dice qué tramo se está viendo, en base 1', () => {
    expect(setup().el.textContent).toContain('1–20 de 45');
  });

  it('en la segunda página el tramo se corre', () => {
    expect(setup({ offset: 20 }).el.textContent).toContain('21–40 de 45');
  });

  it('en la primera página no se puede retroceder', () => {
    expect(setup().prev.disabled).toBe(true);
  });

  it('en la última página no se puede avanzar', () => {
    expect(setup({ offset: 40, count: 5 }).next.disabled).toBe(true);
  });

  it('en el medio se puede para los dos lados', () => {
    const { prev, next } = setup({ offset: 20 });
    expect([prev.disabled, next.disabled]).toEqual([false, false]);
  });

  it('emite prev y next al hacer click', () => {
    const { prev, next, host } = setup({ offset: 20 });
    prev.click();
    next.click();
    expect(host.movimientos).toEqual(['prev', 'next']);
  });

  it('disabled bloquea los dos botones', () => {
    const { prev, next } = setup({ offset: 20, disabled: true });
    expect([prev.disabled, next.disabled]).toEqual([true, true]);
  });

  it('sin resultados no muestra un tramo mentiroso', () => {
    expect(setup({ count: 0, total: 0 }).el.textContent).toContain('0 de 0');
  });
});
