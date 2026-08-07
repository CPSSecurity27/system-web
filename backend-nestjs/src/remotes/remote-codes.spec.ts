import {
  CODE_MAX,
  CODE_MIN,
  codigoValido,
  errorDeCodigo,
  generarCodigo,
  MAX_CODIGOS,
  POSICIONES,
} from './remote-codes';

describe('los límites son los del firmware', () => {
  it('el rango es el de eeprom_store.h', () => {
    expect(CODE_MIN).toBe(10_000);
    expect(CODE_MAX).toBe(999_999_999_999);
  });

  it('el panel guarda 4 códigos por vecino', () => {
    expect(MAX_CODIGOS).toBe(4);
  });

  it('la posición dice QUÉ HACE el botón, no en qué orden se cargó', () => {
    // POS_TO_MODE en alarma_core.c, que el firmware llama "tabla ÚNICA".
    expect(POSICIONES.map((p) => p.modo)).toEqual([
      'emergency',
      'suspicious',
      'alert',
      'off',
    ]);
    // La 4 APAGA: quien tenga ese código puede callar la alarma del barrio.
    expect(POSICIONES[3]).toMatchObject({
      position: 4,
      boton: 'D',
      modo: 'off',
    });
  });
});

describe('codigoValido', () => {
  it('acepta los bordes', () => {
    expect(codigoValido(CODE_MIN)).toBe(true);
    expect(codigoValido(CODE_MAX)).toBe(true);
  });

  it('rechaza afuera de los bordes', () => {
    expect(codigoValido(CODE_MIN - 1)).toBe(false);
    expect(codigoValido(CODE_MAX + 1)).toBe(false);
    expect(codigoValido(0)).toBe(false);
    expect(codigoValido(-5)).toBe(false);
  });

  it('rechaza lo que no es un entero', () => {
    expect(codigoValido(123456.5)).toBe(false);
    expect(codigoValido('123456')).toBe(false);
    expect(codigoValido(null)).toBe(false);
    expect(codigoValido(undefined)).toBe(false);
  });
});

describe('errorDeCodigo', () => {
  it('no dice nada de uno válido', () => {
    expect(errorDeCodigo(123456, 1)).toBeNull();
  });

  it('nombra la posición y el rango efectivo', () => {
    const error = errorDeCodigo(5, 3) ?? '';
    expect(error).toContain('posición 3');
    expect(error).toContain(String(CODE_MIN));
    expect(error).toContain(String(CODE_MAX));
  });

  it('distingue "no es número" de "fuera de rango"', () => {
    expect(errorDeCodigo('abc', 1)).toContain('número entero');
    expect(errorDeCodigo(1, 1)).toContain('fuera');
  });
});

describe('generarCodigo', () => {
  it('siempre cae adentro del rango que el panel guarda', () => {
    for (let i = 0; i < 500; i++) {
      expect(codigoValido(generarCodigo())).toBe(true);
    }
  });

  it('no repite: con 10^12 valores, 500 sorteos no chocan', () => {
    const vistos = new Set<number>();
    for (let i = 0; i < 500; i++) vistos.add(generarCodigo());
    expect(vistos.size).toBe(500);
  });
});
