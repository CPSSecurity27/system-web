import { BadRequestException } from '@nestjs/common';
import {
  deriveSerial,
  formatBoardNumber,
  formatMacHuman,
  macOui,
  mqttTopics,
  normalizeMac,
  parseBoardNumber,
} from './mac';

/**
 * Estas son las funciones que deciden la identidad de un equipo para siempre:
 * un bug acá ensucia la base de forma irreversible (la MAC no se puede corregir
 * después, es la clave del JOIN con el servicio de alarmas).
 *
 * El vector `A8:42:E3:8F:CA:6C` es el del doc de provisioning del GtD
 * (docs/02-provisioning-auth.md), y `24:0A:C4:00:01:10` es la placa real contra
 * la que se verificó el contrato MQTT el 2026-07-24.
 */
describe('normalizeMac', () => {
  it('acepta las formas que produce esptool y un humano, y devuelve una sola', () => {
    for (const entrada of [
      'A8:42:E3:8F:CA:6C',
      'a8:42:e3:8f:ca:6c',
      'a8-42-e3-8f-ca-6c',
      'A842E38FCA6C',
      '  a842e38fca6c  ',
      'a8.42.e3.8f.ca.6c',
    ]) {
      expect(normalizeMac(entrada)).toBe('A842E38FCA6C');
    }
  });

  it('rechaza lo que no son 12 dígitos hex', () => {
    for (const entrada of [
      'A842E38FCA6',
      'A842E38FCA6C7',
      'ZZ42E38FCA6C',
      '',
    ]) {
      expect(() => normalizeMac(entrada)).toThrow(BadRequestException);
    }
  });

  it('rechaza la MAC de ceros: es una lectura fallida de esptool, no un equipo', () => {
    expect(() => normalizeMac('00:00:00:00:00:00')).toThrow(
      /esptool cuando NO pudo leer/,
    );
  });

  it('rechaza la MAC de broadcast', () => {
    expect(() => normalizeMac('FF:FF:FF:FF:FF:FF')).toThrow(/broadcast/);
  });

  it('rechaza una MAC multicast: la de un ESP32 nunca lo es', () => {
    // Bit 0 del primer byte prendido (0xA9) => multicast.
    expect(() => normalizeMac('A9:42:E3:8F:CA:6C')).toThrow(/multicast/);
  });

  it('acepta las MAC de las placas reales del proyecto', () => {
    expect(normalizeMac('24:0A:C4:00:01:10')).toBe('240AC4000110');
    expect(normalizeMac('A8:42:E3:8F:CA:6C')).toBe('A842E38FCA6C');
  });
});

describe('deriveSerial', () => {
  it('produce el usuario MQTT del doc de provisioning', () => {
    expect(deriveSerial('A842E38FCA6C')).toBe('AV-A842E38FCA6C');
  });

  it('encaja con el patrón de serial que ya acepta la base', () => {
    expect(deriveSerial(normalizeMac('24:0A:C4:00:01:10'))).toMatch(
      /^[A-Za-z0-9_-]{3,64}$/,
    );
  });
});

describe('mqttTopics', () => {
  it('arma los cinco tópicos con el serial como <id>, con prefijo AV-', () => {
    // El <id> del tópico es el string COMPLETO, verificado contra placa real.
    expect(mqttTopics('AV-240AC4000110')).toEqual([
      'av/AV-240AC4000110/status',
      'av/AV-240AC4000110/tele',
      'av/AV-240AC4000110/up',
      'av/AV-240AC4000110/cmd',
      'av/AV-240AC4000110/cfg',
    ]);
  });
});

describe('macOui y formatMacHuman', () => {
  it('extrae el OUI del fabricante', () => {
    expect(macOui('A842E38FCA6C')).toBe('A842E3');
  });

  it('muestra la MAC como la ve el operador en esptool', () => {
    expect(formatMacHuman('A842E38FCA6C')).toBe('A8:42:E3:8F:CA:6C');
  });
});

describe('parseBoardNumber', () => {
  it('parte el número impreso en modelo y secuencia', () => {
    expect(parseBoardNumber('ALOY0043')).toEqual({ code: 'ALOY', seq: 43 });
    expect(parseBoardNumber('aloy0001')).toEqual({ code: 'ALOY', seq: 1 });
    expect(parseBoardNumber(' ALOY-9999 ')).toEqual({
      code: 'ALOY',
      seq: 9999,
    });
  });

  it('rechaza formas que no son prefijo + 4 dígitos', () => {
    for (const entrada of ['ALOY43', 'ALOY00043', '0043', 'ALOY', 'A0043']) {
      expect(() => parseBoardNumber(entrada)).toThrow(BadRequestException);
    }
  });

  it('rechaza el 0000: la numeración arranca en 0001', () => {
    expect(() => parseBoardNumber('ALOY0000')).toThrow(/arranca en 0001/);
  });
});

describe('formatBoardNumber', () => {
  it('rearma el string impreso con el relleno de 4 dígitos', () => {
    expect(formatBoardNumber('ALOY', 43)).toBe('ALOY0043');
    expect(formatBoardNumber('ALOY', 1)).toBe('ALOY0001');
    expect(formatBoardNumber('ALOY', 9999)).toBe('ALOY9999');
  });

  it('es la inversa exacta de parseBoardNumber', () => {
    for (const impreso of ['ALOY0001', 'ALOY0043', 'ALOY9999']) {
      const { code, seq } = parseBoardNumber(impreso);
      expect(formatBoardNumber(code, seq)).toBe(impreso);
    }
  });
});
