import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sondearMientras } from './sondeo';

/**
 * El sondeo tiene tres reglas y las tres importan: repregunta mientras se
 * espera, se calla cuando llega la respuesta, y se rinde si no llega nunca. Una
 * ficha abierta y olvidada no puede quedar preguntándole a la Raspberry toda la
 * noche.
 */
@Component({ template: '' })
class Pantalla {
  readonly esperando = signal(false);
  recargas = 0;

  constructor() {
    sondearMientras(
      () => this.esperando(),
      () => this.recargas++,
      { cada: 1000, tope: 10_000 },
    );
  }
}

describe('sondearMientras', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ imports: [Pantalla] });
  });
  afterEach(() => vi.useRealTimers());

  const montar = () => TestBed.createComponent(Pantalla).componentInstance;

  it('no pregunta nada si no se espera nada', () => {
    const p = montar();
    vi.advanceTimersByTime(30_000);
    expect(p.recargas).toBe(0);
  });

  it('repregunta mientras haya algo en vuelo', () => {
    const p = montar();
    p.esperando.set(true);
    vi.advanceTimersByTime(3500);
    expect(p.recargas).toBe(3);
  });

  it('se calla apenas llega la respuesta', () => {
    const p = montar();
    p.esperando.set(true);
    vi.advanceTimersByTime(2000);
    expect(p.recargas).toBe(2);

    p.esperando.set(false);
    vi.advanceTimersByTime(10_000);
    expect(p.recargas).toBe(2);
  });

  it('se rinde si la respuesta no llega nunca', () => {
    // Un panel dormido no contesta hasta que despierte: insistir para siempre
    // no lo despierta, solo gasta la Pi.
    const p = montar();
    p.esperando.set(true);
    vi.advanceTimersByTime(60_000);

    expect(p.recargas).toBeLessThanOrEqual(11);
    const alRendirse = p.recargas;
    vi.advanceTimersByTime(60_000);
    expect(p.recargas).toBe(alRendirse);
  });

  /**
   * El tope se cuenta desde que EMPEZÓ la espera, no desde que se abrió la
   * pantalla. Con un límite fijo al montar, el segundo pedido del día no se
   * habría actualizado nunca.
   */
  it('una espera nueva arranca con su propio presupuesto', () => {
    const p = montar();
    p.esperando.set(true);
    vi.advanceTimersByTime(60_000);
    p.esperando.set(false);
    vi.advanceTimersByTime(5_000);

    const antes = p.recargas;
    p.esperando.set(true);
    vi.advanceTimersByTime(3000);
    expect(p.recargas).toBe(antes + 3);
  });
});
