import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RemotesService } from '../../core/api/remotes.service';
import {
  EtiquetaControl,
  RemoteFabricado,
  RemoteModel,
  ResultadoBusqueda,
} from '../../core/models/api.models';
import { RemoteFactory } from './remote-factory';

function modelo(cambios: Partial<RemoteModel> = {}): RemoteModel {
  return {
    id: 1,
    code: 'CR4',
    name: 'Control de 4 botones',
    buttons: 4,
    active: true,
    notes: null,
    ...cambios,
  };
}

function fabricado(cambios: Partial<RemoteFabricado> = {}): RemoteFabricado {
  return {
    id: 7,
    serial: 'CR-000001',
    claimCode: 'K7M2PQ',
    name: null,
    modelo: modelo(),
    manufacturedAt: new Date().toISOString(),
    codigos: [
      { position: 1, codigo: 111111, boton: 'A', modo: 'emergency', label: 'Emergencia' },
      { position: 2, codigo: 222222, boton: 'B', modo: 'suspicious', label: 'Sospechoso' },
      { position: 3, codigo: 333333, boton: 'C', modo: 'alert', label: 'Alerta' },
      { position: 4, codigo: 444444, boton: 'D', modo: 'off', label: 'Apagar' },
    ],
    ...cambios,
  };
}

function etiquetaDe(c: RemoteFabricado): EtiquetaControl {
  return {
    id: c.id,
    serial: c.serial,
    claimCode: c.claimCode,
    modelo: c.modelo,
    codigos: c.codigos,
  };
}

function enFabrica(cambios: Partial<ResultadoBusqueda> = {}): ResultadoBusqueda {
  return {
    id: 7,
    serial: 'CR-000001',
    status: 'INVENTORY',
    homeId: null,
    modelo: modelo(),
    coincidePor: 'serial',
    readyAt: null,
    removedAt: null,
    position: null,
    boton: null,
    ...cambios,
  };
}

describe('RemoteFactory', () => {
  let fixture: ComponentFixture<RemoteFactory>;
  let componente: RemoteFactory;
  let remotes: {
    modelos: ReturnType<typeof vi.fn>;
    fabricar: ReturnType<typeof vi.fn>;
    etiqueta: ReturnType<typeof vi.fn>;
    buscar: ReturnType<typeof vi.fn>;
    fabricados: ReturnType<typeof vi.fn>;
    marcarListo: ReturnType<typeof vi.fn>;
    remover: ReturnType<typeof vi.fn>;
  };

  async function montar(
    modelos: RemoteModel[] = [modelo()],
    fabricadas: ResultadoBusqueda[] = [],
  ): Promise<void> {
    remotes.modelos.mockReturnValue(of(modelos));
    remotes.fabricados.mockReturnValue(of(fabricadas));
    fixture = TestBed.createComponent(RemoteFactory);
    componente = fixture.componentInstance;
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(() => {
    remotes = {
      modelos: vi.fn(),
      fabricar: vi.fn(),
      etiqueta: vi.fn(),
      buscar: vi.fn(),
      fabricados: vi.fn().mockReturnValue(of([])),
      marcarListo: vi.fn(),
      remover: vi.fn(),
    };
    TestBed.configureTestingModule({
      imports: [RemoteFactory],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: RemotesService, useValue: remotes },
      ],
    });
  });

  it('con un solo modelo lo elige solo: no hay nada que decidir', async () => {
    await montar();
    expect(componente.modeloId()).toBe(1);
    expect(componente.cantidadCodigos()).toBe(4);
  });

  it('los modelos discontinuados no se ofrecen', async () => {
    await montar([modelo(), modelo({ id: 2, code: 'CR2', active: false })]);
    expect(componente.modelos()).toHaveLength(1);
  });

  it('avisa cuántos botones no se pueden registrar', async () => {
    await montar([modelo({ id: 3, code: 'CR6', buttons: 6 })]);
    expect(componente.cantidadCodigos()).toBe(4);
    expect(componente.botonesDeMas()).toBe(2);

    fixture.detectChanges();
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('no se pueden registrar');
  });

  // ── Fabricar ──────────────────────────────────────────────────────

  it('sin cargar nada, fabrica y los códigos los genera el sistema', async () => {
    await montar();
    const control = fabricado();
    remotes.fabricar.mockReturnValue(of(control));
    remotes.etiqueta.mockReturnValue(of(etiquetaDe(control)));

    componente.fabricar();
    await fixture.whenStable();

    expect(remotes.fabricar).toHaveBeenCalledWith(1, false, undefined);
    expect(componente.recien()?.serial).toBe('CR-000001');
  });

  it('el recién fabricado muestra los códigos a grabar, sin repetir el modo', async () => {
    await montar();
    const control = fabricado();
    remotes.fabricar.mockReturnValue(of(control));

    componente.fabricar();
    await fixture.whenStable();
    fixture.detectChanges();

    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('111111');
    // "A emergencia · B sospechoso…" ya está arriba, en el bloque del modelo:
    // repetirlo por cada código es ruido.
    expect(html).not.toContain('111111 Emergencia');
  });

  it('la tabla es la de alarmas: serie, etapa y acciones', async () => {
    await montar([modelo()], [enFabrica()]);

    const encabezados = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll('thead th'),
    ].map((th) => th.textContent?.trim());
    expect(encabezados).toEqual(['Serial', 'Etapa', 'Acciones']);

    // Ni fecha ni códigos en la fila.
    const fila = (fixture.nativeElement as HTMLElement).querySelector('tbody tr');
    expect(fila?.textContent ?? '').not.toContain(
      String(new Date().getFullYear()),
    );
    expect(fila?.textContent ?? '').not.toContain('111111');
  });

  it('la etapa va en su columna, no pegada al número de serie', async () => {
    await montar([modelo()], [enFabrica({ readyAt: new Date().toISOString() })]);

    const celdas = (fixture.nativeElement as HTMLElement).querySelectorAll(
      'tbody tr td',
    );
    // El serial, solo.
    expect(celdas[0].textContent?.trim()).toBe('CR-000001');
    expect(celdas[1].textContent).toContain('Listo');
  });

  it('las acciones son iconos, sin texto', async () => {
    await montar([modelo()], [enFabrica()]);

    const acciones = (fixture.nativeElement as HTMLElement).querySelectorAll(
      'tbody tr td:last-child button',
    );
    // Imprimir, ver códigos, listo y remover.
    expect(acciones).toHaveLength(4);
    for (const boton of acciones) {
      expect(boton.textContent?.trim()).toBe('');
      expect(boton.querySelector('i')).not.toBeNull();
    }
  });

  // ── El visto bueno ────────────────────────────────────────────────

  it('el listado sale del backend, no de lo fabricado en la sesión', async () => {
    await montar([modelo()], [enFabrica({ id: 3, serial: 'CR-000003' })]);
    expect(remotes.fabricados).toHaveBeenCalled();
    expect(componente.listado()[0].serial).toBe('CR-000003');
  });

  it('marcar Listo manda true y actualiza la fila', async () => {
    await montar([modelo()], [enFabrica()]);
    remotes.marcarListo.mockReturnValue(
      of(enFabrica({ readyAt: new Date().toISOString() })),
    );

    componente.marcarListo(componente.listado()[0]);
    await fixture.whenStable();

    expect(remotes.marcarListo).toHaveBeenCalledWith(7, true);
    expect(componente.listado()[0].readyAt).not.toBeNull();
  });

  it('sobre uno ya listo, el botón lo revierte', async () => {
    await montar([modelo()], [enFabrica({ readyAt: new Date().toISOString() })]);
    remotes.marcarListo.mockReturnValue(of(enFabrica({ readyAt: null })));

    componente.marcarListo(componente.listado()[0]);
    await fixture.whenStable();

    expect(remotes.marcarListo).toHaveBeenCalledWith(7, false);
  });

  it('remover lo saca de la lista', async () => {
    await montar([modelo()], [enFabrica()]);
    remotes.remover.mockReturnValue(of(enFabrica({ removedAt: new Date().toISOString() })));

    componente.remover(componente.listado()[0]);
    await fixture.whenStable();

    expect(remotes.remover).toHaveBeenCalledWith(7);
    expect(componente.listado()).toHaveLength(0);
  });

  // ── Ver e imprimir ────────────────────────────────────────────────

  it('ver códigos los trae sin imprimir', async () => {
    await montar([modelo()], [enFabrica()]);
    remotes.etiqueta.mockReturnValue(of(etiquetaDe(fabricado())));

    componente.verCodigos(7);
    await fixture.whenStable();
    fixture.detectChanges();

    expect(remotes.etiqueta).toHaveBeenCalledWith(7);
    expect(componente.codigosVistos()?.serial).toBe('CR-000001');
    // No se preparó nada para la impresora.
    expect(componente.paraImprimir()).toBeNull();
  });

  it('los códigos se abren en un panel sobre la pantalla, no al pie', async () => {
    await montar([modelo()], [enFabrica()]);
    remotes.etiqueta.mockReturnValue(of(etiquetaDe(fabricado())));

    componente.verCodigos(7);
    await fixture.whenStable();
    fixture.detectChanges();

    // Mismo patrón que las credenciales del equipo: fondo y foco propios.
    const panel = (fixture.nativeElement as HTMLElement).querySelector(
      '.position-fixed',
    );
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('111111');
  });

  it('imprimir prepara la etiqueta antes de llamar al navegador', async () => {
    await montar([modelo()], [enFabrica()]);
    remotes.etiqueta.mockReturnValue(of(etiquetaDe(fabricado())));
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);

    componente.imprimir(7);
    await fixture.whenStable();

    // El QR tiene que estar en el DOM ANTES de imprimir: si no, sale sin QR.
    expect(componente.paraImprimir()?.serial).toBe('CR-000001');
    expect(print).not.toHaveBeenCalled();
    print.mockRestore();
  });

  // ── Buscador ──────────────────────────────────────────────────────

  it('busca por serial o por código y muestra qué botón coincidió', async () => {
    await montar();
    remotes.buscar.mockReturnValue(
      of([
        enFabrica({ coincidePor: 'codigo', position: 3, boton: 'C' }),
      ]),
    );

    componente.consulta.set('810003');
    componente.buscar();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(remotes.buscar).toHaveBeenCalledWith('810003');
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('CR-000001');
    expect(html).toContain('botón C');
  });

  it('sin resultados lo dice, en vez de quedar en blanco', async () => {
    await montar();
    remotes.buscar.mockReturnValue(of([]));

    componente.consulta.set('CR-999999');
    componente.buscar();
    await fixture.whenStable();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'Ningún control',
    );
  });

  it('una consulta vacía no llega al backend', async () => {
    await montar();
    componente.consulta.set('   ');
    componente.buscar();
    expect(remotes.buscar).not.toHaveBeenCalled();
    expect(componente.resultados()).toBeNull();
  });

  // ── De dónde salen los códigos ────────────────────────────────────

  it('correlativo viaja al backend', async () => {
    await montar();
    const control = fabricado();
    remotes.fabricar.mockReturnValue(of(control));
    remotes.etiqueta.mockReturnValue(of(etiquetaDe(control)));

    componente.cambiarModo('correlativo');
    componente.fabricar();
    await fixture.whenStable();

    expect(remotes.fabricar).toHaveBeenCalledWith(1, true, undefined);
  });

  it('el default es al azar: un código no se tiene que poder adivinar', async () => {
    await montar();
    expect(componente.modo()).toBe('azar');
  });

  it('no hay apodo: acá se trabaja por número de serie', async () => {
    await montar();
    expect((fixture.nativeElement as HTMLElement).textContent ?? '').not.toContain(
      'Apodo',
    );
  });

  // ── Códigos a mano ────────────────────────────────────────────────

  /** Carga los cuatro campos del modo manual. */
  function tipear(...codigos: string[]): void {
    codigos.forEach((c, i) => componente.escribirCodigo(i, c));
  }

  it('un campo por botón, en el orden que espera el panel', async () => {
    await montar();
    componente.cambiarModo('manual');
    fixture.detectChanges();

    expect(componente.camposManuales().map((c) => c.boton)).toEqual([
      'A',
      'B',
      'C',
      'D',
    ]);
    const html = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(html).toContain('Emergencia');
    expect(html).toContain('Apagar');
  });

  it('el modelo decide cuántos campos hay', async () => {
    await montar([modelo({ id: 2, code: 'CR2', buttons: 2 })]);
    componente.cambiarModo('manual');
    expect(componente.camposManuales()).toHaveLength(2);
  });

  it('los códigos tipeados viajan al backend en orden de posición', async () => {
    await montar();
    const control = fabricado();
    remotes.fabricar.mockReturnValue(of(control));

    componente.cambiarModo('manual');
    tipear('111111', '222222', '333333', '444444');
    expect(componente.puedeFabricar()).toBe(true);

    componente.fabricar();
    await fixture.whenStable();

    expect(remotes.fabricar).toHaveBeenCalledWith(1, false, [
      111111, 222222, 333333, 444444,
    ]);
  });

  it('a medio cargar no se fabrica: un control sin sus 4 códigos no sirve', async () => {
    await montar();
    componente.cambiarModo('manual');
    tipear('111111', '222222');

    expect(componente.puedeFabricar()).toBe(false);
    componente.fabricar();
    expect(remotes.fabricar).not.toHaveBeenCalled();
  });

  it('rechaza lo que el equipo no guarda, sin ir al backend', async () => {
    await montar();
    componente.cambiarModo('manual');
    tipear('123', '222222', '333333', '444444');

    expect(componente.camposManuales()[0].error).toContain('10000');
    expect(componente.puedeFabricar()).toBe(false);
  });

  it('un código que no es un número se explica solo', async () => {
    await montar();
    componente.cambiarModo('manual');
    tipear('11.11', '222222', '333333', '444444');

    expect(componente.camposManuales()[0].error).toContain('Solo números');
  });

  it('el mismo código en dos posiciones se marca en las dos', async () => {
    await montar();
    componente.cambiarModo('manual');
    tipear('111111', '111111', '333333', '444444');

    const campos = componente.camposManuales();
    expect(campos[0].error).toContain('Repetido');
    expect(campos[1].error).toContain('Repetido');
    expect(campos[2].error).toBeNull();
    expect(componente.puedeFabricar()).toBe(false);
  });

  it('un campo vacío todavía no es un error', async () => {
    await montar();
    componente.cambiarModo('manual');
    expect(componente.camposManuales().every((c) => c.error === null)).toBe(true);
  });

  it('después de fabricar, los campos quedan limpios para el siguiente', async () => {
    await montar();
    remotes.fabricar.mockReturnValue(of(fabricado()));

    componente.cambiarModo('manual');
    tipear('111111', '222222', '333333', '444444');
    componente.fabricar();
    await fixture.whenStable();

    expect(componente.manuales()).toEqual(['', '', '', '']);
    // El modo se queda: si se fabrica a mano, casi siempre es más de uno.
    expect(componente.modo()).toBe('manual');
  });

  it('volver a al azar no manda lo que había quedado tipeado', async () => {
    await montar();
    remotes.fabricar.mockReturnValue(of(fabricado()));

    componente.cambiarModo('manual');
    tipear('111111', '222222', '333333', '444444');
    componente.cambiarModo('azar');
    componente.fabricar();
    await fixture.whenStable();

    expect(remotes.fabricar).toHaveBeenCalledWith(1, false, undefined);
  });

  // ── Errores ───────────────────────────────────────────────────────

  it('un código repetido se muestra tal cual lo explica el backend', async () => {
    await montar();
    remotes.fabricar.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            status: 409,
            error: {
              message: 'El código 111111 ya está cargado en otro control',
            },
          }),
      ),
    );

    componente.fabricar();
    await fixture.whenStable();

    expect(componente.error()).toContain('ya está cargado en otro control');
    // Y no se agrega nada al listado: no se fabricó nada.
    expect(componente.fabricados()).toHaveLength(0);
  });
});
