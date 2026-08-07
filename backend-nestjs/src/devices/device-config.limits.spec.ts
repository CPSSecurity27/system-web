import {
  MAX_PAYLOAD_BYTES,
  MAX_PSW_CHARS,
  MAX_REDES,
  MAX_SSID_CHARS,
  MODOS_AUTOOFF,
  validarPatch,
} from './device-config.limits';

/** El roaming va completo: mandarlo a medias hace descartar la cfg entera. */
const ROAM_OK = { roam_rssi: -72, roam_delta: 10, roam_cooldown_s: 300 };

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
    const roam = (parcial: Record<string, number>) =>
      validarPatch({ red_avanzada: { ...ROAM_OK, ...parcial } });

    expect(roam({ roam_rssi: -90 })).toEqual([]);
    expect(roam({ roam_rssi: -50 })).toEqual([]);
    expect(roam({ roam_rssi: -91 })).toHaveLength(1);
    expect(roam({ roam_rssi: -49 })).toHaveLength(1);
    expect(roam({ roam_delta: 4 })).toHaveLength(1);
    expect(roam({ roam_delta: 31 })).toHaveLength(1);
    expect(roam({ roam_cooldown_s: 59 })).toHaveLength(1);
    expect(roam({ roam_cooldown_s: 3601 })).toHaveLength(1);
  });

  it('el roaming a medias se rechaza: el panel descartaría la cfg entera', () => {
    const errores = validarPatch({ red_avanzada: { roam_rssi: -72 } });
    expect(errores).toHaveLength(1);
    expect(errores[0]).toContain('roam_delta');
  });

  it('acumula todos los errores, no corta en el primero', () => {
    const errores = validarPatch({
      tiempos: { send_tele_s: 1 },
      red_avanzada: { ...ROAM_OK, roam_delta: 99 },
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

  // ── Huso horario: el que NO se clampa ─────────────────────────────────
  // Fuera de ±14 h el firmware descarta la cfg entera y no manda ack. Sin esta
  // validación, un huso mal tipeado deja la pantalla esperando para siempre.

  it('acepta el huso horario en los bordes de ±14 h', () => {
    expect(validarPatch({ hora: { tz_offset_s: -50400 } })).toEqual([]);
    expect(validarPatch({ hora: { tz_offset_s: 50400 } })).toEqual([]);
    expect(validarPatch({ hora: { tz_offset_s: -10800 } })).toEqual([]);
  });

  it('rechaza un huso horario fuera de rango', () => {
    expect(validarPatch({ hora: { tz_offset_s: -50401 } })).toHaveLength(1);
    expect(validarPatch({ hora: { tz_offset_s: 50401 } })).toHaveLength(1);
  });

  it('el huso en horas en vez de segundos no llega al equipo', () => {
    // El error de tipeo real: escribir -3 pensando en horas. Cae adentro del
    // rango, así que esto NO lo agarra nadie — queda documentado que el
    // formulario tiene que pedirlo en horas y multiplicar él.
    expect(validarPatch({ hora: { tz_offset_s: -3 } })).toEqual([]);
  });

  // ── Auto-apagado por modo ─────────────────────────────────────────────

  it('acepta el auto-apagado en los bordes, para los 7 modos', () => {
    for (const modo of MODOS_AUTOOFF) {
      expect(validarPatch({ alarma: { autooff: { [modo]: 120 } } })).toEqual(
        [],
      );
      expect(validarPatch({ alarma: { autooff: { [modo]: 1800 } } })).toEqual(
        [],
      );
      expect(
        validarPatch({ alarma: { autooff: { [modo]: 119 } } }),
      ).toHaveLength(1);
      expect(
        validarPatch({ alarma: { autooff: { [modo]: 1801 } } }),
      ).toHaveLength(1);
    }
  });

  it('el error del auto-apagado nombra el modo', () => {
    const errores = validarPatch({ alarma: { autooff: { fire: 5 } } });
    expect(errores[0]).toContain('fire');
    expect(errores[0]).toContain('120');
  });

  it('rechaza el 0 del auto-apagado aunque el protocolo lo acepte', () => {
    // Para el firmware 0 es "no tocar este modo". Nosotros mandamos siempre los
    // siete valores tomados del espejo: acá un 0 solo puede ser un tipeo.
    expect(validarPatch({ alarma: { autooff: { panic: 0 } } })).toHaveLength(1);
  });

  it('los 7 modos malos dan 7 errores, no uno', () => {
    const autooff = Object.fromEntries(MODOS_AUTOOFF.map((m) => [m, 1]));
    expect(validarPatch({ alarma: { autooff } })).toHaveLength(7);
  });

  // ── Buffers y slot ────────────────────────────────────────────────────

  it('rechaza un SSID más largo que el buffer del panel', () => {
    const errores = validarPatch({
      redes: [{ ssid: 'x'.repeat(MAX_SSID_CHARS + 1) }],
    });
    expect(errores).toHaveLength(1);
    expect(errores[0]).toContain(String(MAX_SSID_CHARS));
  });

  it('acepta un SSID justo en el límite', () => {
    expect(
      validarPatch({ redes: [{ ssid: 'x'.repeat(MAX_SSID_CHARS) }] }),
    ).toEqual([]);
  });

  it('rechaza una contraseña más larga que el buffer del panel', () => {
    expect(
      validarPatch({
        redes: [{ ssid: 'casa', psw: 'y'.repeat(MAX_PSW_CHARS + 1) }],
      }),
    ).toHaveLength(1);
  });

  it('valida la prioridad de cada red', () => {
    expect(validarPatch({ redes: [{ ssid: 'casa', prio: 1 }] })).toEqual([]);
    expect(validarPatch({ redes: [{ ssid: 'casa', prio: 5 }] })).toEqual([]);
    expect(validarPatch({ redes: [{ ssid: 'casa', prio: 0 }] })).toHaveLength(
      1,
    );
    expect(validarPatch({ redes: [{ ssid: 'casa', prio: 6 }] })).toHaveLength(
      1,
    );
  });

  it('valida el slot de eeprom', () => {
    expect(validarPatch({ modulos: { eeprom_slot: 0 } })).toEqual([]);
    expect(validarPatch({ modulos: { eeprom_slot: 1 } })).toEqual([]);
    expect(validarPatch({ modulos: { eeprom_slot: 2 } })).toHaveLength(1);
  });

  it('los booleanos de módulos no se tocan al validar el slot', () => {
    expect(
      validarPatch({
        modulos: {
          ds3231: true,
          eeprom: true,
          supervisor: false,
          rf: true,
          eeprom_slot: 1,
        },
      }),
    ).toEqual([]);
  });
});
