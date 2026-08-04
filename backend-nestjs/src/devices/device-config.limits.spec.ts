import {
  MAX_PAYLOAD_BYTES,
  MAX_REDES,
  validarPatch,
} from './device-config.limits';

describe('validarPatch', () => {
  it('acepta un patch vacío', () => {
    expect(validarPatch({})).toEqual([]);
  });

  it('acepta send_tele_s en los bordes', () => {
    expect(validarPatch({ tiempos: { send_tele_s: 30 } })).toEqual([]);
    expect(validarPatch({ tiempos: { send_tele_s: 86400 } })).toEqual([]);
  });

  it('rechaza send_tele_s por debajo del mínimo, diciendo el efectivo', () => {
    const errores = validarPatch({ tiempos: { send_tele_s: 29 } });
    expect(errores).toHaveLength(1);
    expect(errores[0]).toContain('30');
  });

  it('rechaza send_tele_s por encima del máximo', () => {
    expect(validarPatch({ tiempos: { send_tele_s: 86401 } })).toHaveLength(1);
  });

  it('acepta hasta 5 redes y rechaza la sexta', () => {
    const red = { ssid: 'x', psw: 'y' };
    expect(validarPatch({ redes: Array(MAX_REDES).fill(red) })).toEqual([]);
    expect(
      validarPatch({ redes: Array(MAX_REDES + 1).fill(red) }),
    ).toHaveLength(1);
  });

  it('valida los bordes del roaming', () => {
    expect(validarPatch({ red_avanzada: { roam_rssi: -90 } })).toEqual([]);
    expect(validarPatch({ red_avanzada: { roam_rssi: -50 } })).toEqual([]);
    expect(validarPatch({ red_avanzada: { roam_rssi: -91 } })).toHaveLength(1);
    expect(validarPatch({ red_avanzada: { roam_rssi: -49 } })).toHaveLength(1);
    expect(validarPatch({ red_avanzada: { roam_delta: 4 } })).toHaveLength(1);
    expect(validarPatch({ red_avanzada: { roam_delta: 31 } })).toHaveLength(1);
    expect(
      validarPatch({ red_avanzada: { roam_cooldown_s: 59 } }),
    ).toHaveLength(1);
    expect(
      validarPatch({ red_avanzada: { roam_cooldown_s: 3601 } }),
    ).toHaveLength(1);
  });

  it('acumula todos los errores, no corta en el primero', () => {
    const errores = validarPatch({
      tiempos: { send_tele_s: 1 },
      red_avanzada: { roam_delta: 99 },
    });
    expect(errores).toHaveLength(2);
  });

  it('rechaza una red sin ssid', () => {
    expect(validarPatch({ redes: [{ psw: 'sin-ssid' }] })).toHaveLength(1);
  });

  it('rechaza un valor que no es número', () => {
    expect(validarPatch({ tiempos: { send_tele_s: '300' } })).toHaveLength(1);
  });

  it('el límite de payload es el del firmware', () => {
    expect(MAX_PAYLOAD_BYTES).toBe(1024);
  });
});
