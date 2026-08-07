import {
  armarComando,
  COMANDOS,
  CONSECUENCIA,
  esComando,
  MAX_OTA_BASE_CHARS,
  MODOS_ALARMA,
} from './device-commands';

const SERIAL = 'AV-A842E38FCA6C';

describe('armarComando', () => {
  it('los comandos sin parámetros viajan con el payload vacío', () => {
    for (const tipo of [
      'estado',
      'i2c_scan',
      'restart',
      'scan',
      'refresh',
    ] as const) {
      const { payload, errores } = armarComando(tipo, {}, SERIAL);
      expect(errores).toEqual([]);
      expect(payload).toEqual({});
    }
  });

  it('la hora pide sincronizar', () => {
    expect(armarComando('hora', {}, SERIAL).payload).toEqual({ op: 'sync' });
  });

  // ── factory ──────────────────────────────────────────────────────────
  // El firmware compara el `confirm` contra su propio ID (AV-<MAC>), que es
  // exactamente nuestro serial. Si no coincide, contesta error y no hace nada.

  it('factory manda el serial como confirmación', () => {
    const { payload, errores } = armarComando('factory', {}, SERIAL);
    expect(errores).toEqual([]);
    expect(payload).toEqual({ confirm: SERIAL });
  });

  it('la consecuencia de factory nombra lo que se pierde y lo que no', () => {
    const texto = CONSECUENCIA.factory ?? '';
    expect(texto).toContain('WiFi');
    // Lo verificado en el firmware: factory es nvs_erase, y la base RF vive en
    // la EEPROM externa. Los controles sobreviven.
    expect(texto).toContain('NO se borran');
  });

  // ── red (destrabar un SSID bloqueado) ────────────────────────────────

  it('destrabar una red exige el SSID', () => {
    expect(armarComando('red', {}, SERIAL).errores).toHaveLength(1);
    expect(armarComando('red', { ssid: '' }, SERIAL).errores).toHaveLength(1);
  });

  it('destrabar arma la operación bl_clear', () => {
    const { payload, errores } = armarComando(
      'red',
      { ssid: 'MuniWiFi' },
      SERIAL,
    );
    expect(errores).toEqual([]);
    expect(payload).toEqual({ op: 'bl_clear', ssid: 'MuniWiFi' });
  });

  it('un SSID más largo que el buffer del panel se rechaza', () => {
    expect(
      armarComando('red', { ssid: 'x'.repeat(32) }, SERIAL).errores,
    ).toHaveLength(1);
  });

  // ── ota ──────────────────────────────────────────────────────────────

  it('sin origen, el OTA usa el automático del equipo', () => {
    const { payload, errores } = armarComando('ota', {}, SERIAL);
    expect(errores).toEqual([]);
    expect(payload).toEqual({ fuente: 'auto' });
  });

  it('con origen url exige la url', () => {
    expect(armarComando('ota', { fuente: 'url' }, SERIAL).errores).toHaveLength(
      1,
    );
  });

  it('la url del OTA tiene que ser http(s)', () => {
    const errores = armarComando(
      'ota',
      { fuente: 'url', base: 'ftp://server/fw' },
      SERIAL,
    ).errores;
    expect(errores).toHaveLength(1);
    expect(errores[0]).toContain('http');
  });

  it('una url más larga que el buffer se rechaza antes de mandarla', () => {
    // El firmware la truncaría en silencio y el equipo bajaría de cualquier lado.
    const larga = 'https://cps.ar/' + 'x'.repeat(MAX_OTA_BASE_CHARS);
    expect(
      armarComando('ota', { fuente: 'url', base: larga }, SERIAL).errores,
    ).toHaveLength(1);
  });

  it('una url válida viaja tal cual', () => {
    const base = 'https://firmware.cps.ar/aloy/6.0.2';
    const { payload, errores } = armarComando(
      'ota',
      { fuente: 'url', base },
      SERIAL,
    );
    expect(errores).toEqual([]);
    expect(payload).toEqual({ fuente: 'url', base });
  });
});

describe('catálogo', () => {
  it('rf, cal y test NO están: cada uno tiene su razón escrita', () => {
    for (const fuera of ['rf', 'cal', 'test', 'alarma']) {
      expect(esComando(fuera)).toBe(false);
    }
  });

  it('todos los comandos declaran su consecuencia (aunque sea ninguna)', () => {
    for (const tipo of COMANDOS) {
      expect(CONSECUENCIA).toHaveProperty(tipo);
    }
  });

  it('los modos de alarma son los slugs del firmware, con off adentro', () => {
    expect(MODOS_ALARMA).toContain('off');
    expect(MODOS_ALARMA).toContain('emergency');
    expect(MODOS_ALARMA).toHaveLength(8);
  });
});
