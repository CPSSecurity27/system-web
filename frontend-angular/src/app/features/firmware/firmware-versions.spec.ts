import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of, throwError } from 'rxjs';

import { FirmwareService } from '../../core/api/firmware.service';
import { FirmwareRanura, FirmwareRelease } from '../../core/models/api.models';
import { FirmwareVersions } from './firmware-versions';

function release(cambios: Partial<FirmwareRelease> = {}): FirmwareRelease {
  return {
    id: 1,
    version: 'new_0_6_0',
    channel: 'new',
    hwModel: 'esp32-4mb',
    projectName: 'AlarmaESP32V6_05-03-2026',
    sizeBytes: 1_265_616,
    sha256: 'f'.repeat(64),
    notes: null,
    subidoPor: 'CPS',
    creadoEn: new Date().toISOString(),
    url: 'https://cpssecurity.com.ar/firmware/alarmavecinal/ota/new_0_6_0/',
    publicadoEn: [],
    ...cambios,
  };
}

function ranura(slot: 'new' | 'emergency', releaseId: number): FirmwareRanura {
  return {
    slot,
    version: `v${releaseId}`,
    releaseId,
    url: `https://cpssecurity.com.ar/firmware/alarmavecinal/ota/${slot}/`,
    actualizadoPor: 'CPS',
    actualizadoEn: new Date().toISOString(),
  };
}

describe('FirmwareVersions', () => {
  let fixture: ComponentFixture<FirmwareVersions>;
  let componente: FirmwareVersions;
  let api: {
    listar: ReturnType<typeof vi.fn>;
    ranuras: ReturnType<typeof vi.fn>;
    subir: ReturnType<typeof vi.fn>;
    publicar: ReturnType<typeof vi.fn>;
    borrar: ReturnType<typeof vi.fn>;
    verificar: ReturnType<typeof vi.fn>;
  };

  function montar(versiones: FirmwareRelease[] = [], ranuras: FirmwareRanura[] = []) {
    api = {
      listar: vi.fn().mockReturnValue(of(versiones)),
      ranuras: vi.fn().mockReturnValue(of(ranuras)),
      subir: vi.fn().mockReturnValue(of(release())),
      publicar: vi.fn().mockReturnValue(of(ranuras)),
      borrar: vi.fn().mockReturnValue(of(undefined)),
      verificar: vi.fn().mockReturnValue(
        of({ raiz: '/tmp/fw', escribible: true, ranuras: [], faltantes: [] }),
      ),
    };

    TestBed.configureTestingModule({
      imports: [FirmwareVersions],
      providers: [
        provideZonelessChangeDetection(),
        { provide: FirmwareService, useValue: api },
      ],
    });

    fixture = TestBed.createComponent(FirmwareVersions);
    componente = fixture.componentInstance;
    fixture.detectChanges();
  }

  // ── Subir ────────────────────────────────────────────────────────

  it('no deja subir sin archivo ni sin versión', () => {
    montar();
    expect(componente['puedeSubir']()).toBe(false);

    componente['version'].set('new_0_7_0');
    expect(componente['puedeSubir']()).toBe(false);

    componente['archivo'].set(new File(['x'], 'fw.bin'));
    expect(componente['puedeSubir']()).toBe(true);
  });

  it('manda el archivo, la versión y las notas', () => {
    montar();
    const file = new File(['x'], 'fw.bin');
    componente['archivo'].set(file);
    componente['version'].set(' new_0_7_0 ');
    componente['notas'].set(' arregla el RF ');

    componente['subir']();

    expect(api.subir).toHaveBeenCalledWith(file, 'new_0_7_0', 'arregla el RF');
  });

  it('avisa que cargar NO es publicar', () => {
    // El error caro: subir el .bin, irse, y creer que los equipos ya lo tienen.
    montar();
    componente['archivo'].set(new File(['x'], 'fw.bin'));
    componente['version'].set('new_0_7_0');

    componente['subir']();

    expect(componente['aviso']()).toMatch(/publicarla/i);
  });

  it('un rechazo del backend se muestra tal cual', () => {
    montar();
    api.subir.mockReturnValue(
      throwError(
        () =>
          new HttpErrorResponse({
            error: { message: 'Esto no es una imagen de ESP32' },
            status: 400,
          }),
      ),
    );
    componente['archivo'].set(new File(['x'], 'fw.bin'));
    componente['version'].set('new_0_7_0');

    componente['subir']();

    expect(componente['error']()).toMatch(/no es una imagen/i);
    expect(componente['subiendo']()).toBe(false);
  });

  // ── Las dos ranuras ──────────────────────────────────────────────

  it('avisa cuando la de emergencia es la misma que la automática', () => {
    // La de emergencia es el ÚLTIMO BUENO CONOCIDO: si es la misma versión de
    // la que el equipo trata de escapar, el mecanismo no sirve para nada.
    montar([release()], [ranura('new', 1), ranura('emergency', 1)]);
    expect(componente['emergenciaEsLaMisma']()).toBe(true);
  });

  it('con versiones distintas en cada ranura no avisa nada', () => {
    montar([release()], [ranura('new', 2), ranura('emergency', 1)]);
    expect(componente['emergenciaEsLaMisma']()).toBe(false);
  });

  it('con una sola ranura publicada tampoco avisa', () => {
    montar([release()], [ranura('new', 1)]);
    expect(componente['emergenciaEsLaMisma']()).toBe(false);
  });

  // ── Publicar ─────────────────────────────────────────────────────

  it('publicar en new pide confirmar antes de tocar nada', () => {
    montar([release()]);
    componente['pedirPublicar'](release(), 'new');

    expect(componente['publicando']()?.slot).toBe('new');
    expect(api.publicar).not.toHaveBeenCalled();

    componente['confirmarPublicacion']();
    expect(api.publicar).toHaveBeenCalledWith(1, 'new');
  });

  it('publicar aclara que todavía no se mandó nada a ningún equipo', () => {
    montar([release()]);
    componente['pedirPublicar'](release(), 'new');
    componente['confirmarPublicacion']();

    expect(componente['aviso']()).toMatch(/Falta mandársela/i);
  });

  it('cancelar la confirmación no publica', () => {
    montar([release()]);
    componente['pedirPublicar'](release(), 'emergency');
    componente['cancelarPublicacion']();

    expect(componente['publicando']()).toBeNull();
    expect(api.publicar).not.toHaveBeenCalled();
  });

  // ── Borrar ───────────────────────────────────────────────────────

  it('borrar también pide confirmar', () => {
    montar([release()]);
    componente['pedirBorrar'](release());
    expect(api.borrar).not.toHaveBeenCalled();

    componente['confirmarBorrado']();
    expect(api.borrar).toHaveBeenCalledWith(1);
  });

  // ── Verificar ────────────────────────────────────────────────────

  it('el chequeo del servidor guarda lo que devolvió', () => {
    montar();
    componente['verificar']();

    expect(componente['chequeo']()?.escribible).toBe(true);
    expect(componente['chequeando']()).toBe(false);
  });

  it('sabe en qué ranuras está publicada cada versión', () => {
    montar();
    expect(componente['estaEn'](release({ publicadoEn: ['new'] }), 'new')).toBe(true);
    expect(componente['estaEn'](release({ publicadoEn: ['new'] }), 'emergency')).toBe(
      false,
    );
  });
});
