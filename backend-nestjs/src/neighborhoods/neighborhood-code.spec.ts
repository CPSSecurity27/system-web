import { codigoLibreDeBarrio, slugDeBarrio } from './neighborhood-code';

/**
 * El código corto que viaja al equipo como `central.grupo`.
 *
 * La base lo exige `NOT NULL`, UNIQUE y con el formato
 * `^[A-Z0-9][A-Z0-9-]{0,14}$`. Cualquier cosa que salga de acá y no cumpla eso
 * hace fallar el alta de un barrio — que es exactamente lo que venía pasando
 * cuando nadie lo generaba.
 */
const FORMATO = /^[A-Z0-9][A-Z0-9-]{0,14}$/;

describe('slugDeBarrio', () => {
  it('mayúsculas y guiones en lugar de los espacios', () => {
    expect(slugDeBarrio('Barrio Norte')).toBe('BARRIO-NORT');
  });

  it('saca los acentos y la eñe', () => {
    // Sin esto el código sale con caracteres que el CHECK rechaza.
    expect(slugDeBarrio('Peñalolén')).toBe('PENALOLEN');
    expect(slugDeBarrio('Córdoba')).toBe('CORDOBA');
  });

  it('trunca a 11 para dejar lugar al desempate', () => {
    // 11 + '-999' = 15 justos, que es el techo del firmware.
    expect(slugDeBarrio('Barrio Parque Los Aromos').length).toBe(11);
  });

  it('no deja un guión colgando después de truncar', () => {
    // "BARRIO-DEL-" cortado en 11 terminaría en guión y el resultado sería
    // "BARRIO-DEL--2": feo, y con un guión doble que no aporta nada.
    expect(slugDeBarrio('Barrio del Sol')).not.toMatch(/-$/);
  });

  it('un nombre sin caracteres usables no tumba el alta', () => {
    expect(slugDeBarrio('...')).toBe('B');
    expect(slugDeBarrio('')).toBe('B');
  });

  it('lo que sale siempre cumple el formato de la base', () => {
    for (const nombre of [
      'Barrio Norte',
      'Peñalolén',
      '...',
      '  espacios  ',
      'Barrio 12 de Octubre',
      'Ñ',
      'a',
      'Villa 31 bis',
    ]) {
      expect(slugDeBarrio(nombre)).toMatch(FORMATO);
    }
  });
});

describe('codigoLibreDeBarrio', () => {
  const ninguno = () => Promise.resolve(false);

  it('usa el slug pelado si está libre', async () => {
    expect(await codigoLibreDeBarrio('Barrio Norte', ninguno)).toBe(
      'BARRIO-NORT',
    );
  });

  it('desempata con un número cuando ya existe', async () => {
    // El caso real: "Barrio Norte" en dos localidades distintas.
    const tomados = new Set(['BARRIO-NORT']);
    expect(
      await codigoLibreDeBarrio('Barrio Norte', (c) =>
        Promise.resolve(tomados.has(c)),
      ),
    ).toBe('BARRIO-NORT-2');
  });

  it('sigue subiendo hasta encontrar uno libre', async () => {
    const tomados = new Set(['BARRIO-NORT', 'BARRIO-NORT-2', 'BARRIO-NORT-3']);
    expect(
      await codigoLibreDeBarrio('Barrio Norte', (c) =>
        Promise.resolve(tomados.has(c)),
      ),
    ).toBe('BARRIO-NORT-4');
  });

  it('el desempate tampoco se pasa de 15 caracteres', async () => {
    const tomados = new Set(['BARRIO-NORT']);
    const code = await codigoLibreDeBarrio('Barrio Norte', (c) =>
      Promise.resolve(tomados.has(c)),
    );
    expect(code.length).toBeLessThanOrEqual(15);
    expect(code).toMatch(FORMATO);
  });

  it('falla con un mensaje claro si no hay ninguno libre', async () => {
    // Mil barrios con el mismo nombre no es un caso real, pero reventar el
    // UNIQUE con el nombre de una constraint sería peor que decirlo.
    await expect(
      codigoLibreDeBarrio('Barrio Norte', () => Promise.resolve(true)),
    ).rejects.toThrow(/código único/);
  });
});
