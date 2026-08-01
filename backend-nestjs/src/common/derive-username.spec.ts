import { deriveUsername } from './derive-username';

describe('deriveUsername', () => {
  it('pasa a minúsculas y cambia espacios por guión bajo', () => {
    expect(deriveUsername('Municipalidad San Pedro')).toBe(
      'municipalidad_san_pedro',
    );
  });

  it('saca los acentos', () => {
    expect(deriveUsername('Consorcio Los Álamos')).toBe('consorcio_los_alamos');
  });

  it('saca "de", "del" e "y", que no aportan nada', () => {
    expect(deriveUsername('Municipalidad de San Pedro')).toBe(
      'municipalidad_san_pedro',
    );
    expect(deriveUsername('Barrio Norte y Sur')).toBe('barrio_norte_sur');
  });

  it('CONSERVA los artículos: son parte del nombre real', () => {
    // "Los Álamos" se llama así. Borrarle el "Los" lo desfigura.
    expect(deriveUsername('Junta de los Vecinos del Norte')).toBe(
      'junta_los_vecinos_norte',
    );
  });

  it('saca la puntuación', () => {
    expect(deriveUsername('Consorcio "Los Álamos" S.A.')).toBe(
      'consorcio_los_alamos_s_a',
    );
  });

  it('no deja guiones bajos repetidos ni en las puntas', () => {
    expect(deriveUsername('  Barrio   ---  Norte  ')).toBe('barrio_norte');
  });

  it('recorta a 30 caracteres', () => {
    expect(
      deriveUsername('Municipalidad de San Salvador de Jujuy Capital').length,
    ).toBeLessThanOrEqual(30);
  });

  it('al recortar corta por palabra, sin dejar un guión colgando', () => {
    expect(
      deriveUsername('Municipalidad de San Salvador de Jujuy Capital'),
    ).toBe('municipalidad_san_salvador');
  });

  it('una sola palabra más larga que el máximo se corta igual', () => {
    expect(
      deriveUsername('Superlargoconsorciodenominacionextensa').length,
    ).toBe(30);
  });

  it('un nombre que se queda sin letras devuelve cadena vacía, no basura', () => {
    expect(deriveUsername('de y del')).toBe('');
    expect(deriveUsername('...')).toBe('');
  });

  it('conserva los números: son parte del nombre', () => {
    expect(deriveUsername('Consorcio 25 de Mayo')).toBe('consorcio_25_mayo');
  });

  it('la ñ se conserva como n', () => {
    expect(deriveUsername('Barrio Peña')).toBe('barrio_pena');
  });
});
