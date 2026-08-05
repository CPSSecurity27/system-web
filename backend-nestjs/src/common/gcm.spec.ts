import { loadKey, open, seal } from './gcm';

/**
 * El formato de cifrado del proyecto. Importa más que de costumbre porque lo
 * escribe OTRO proceso, en otro lenguaje y en otro repo: el provisioner del GtD
 * (`src/gtd/provisioner/cifrado.py`). Si el layout de los campos se desincroniza
 * entre los dos, el síntoma es "el descifrado falla" y no dice por qué.
 */
const CLAVE = Buffer.alloc(32, 7).toString('base64');

describe('loadKey', () => {
  it('acepta 32 bytes en base64', () => {
    expect(loadKey(CLAVE, 'X').length).toBe(32);
  });

  it('rechaza una clave corta nombrando la variable', () => {
    // Falla al ARRANCAR, no al primer uso: una clave corta es un agujero
    // silencioso.
    expect(() => loadKey('AAAA', 'CPS_CRED_KEY')).toThrow(/CPS_CRED_KEY/);
  });

  it('rechaza una clave vacía', () => {
    expect(() => loadKey('', 'CPS_CRED_KEY')).toThrow(/32 bytes/);
  });
});

describe('seal / open', () => {
  const key = loadKey(CLAVE, 'X');

  it('ida y vuelta', () => {
    expect(open(key, seal(key, '2B0C49'))).toBe('2B0C49');
  });

  it('dos cifrados del mismo texto son distintos', () => {
    // IV random por llamada: si no, dos equipos con la misma password se
    // delatan mirando la base.
    expect(seal(key, '2B0C49')).not.toEqual(seal(key, '2B0C49'));
  });

  it('un ciphertext alterado TIRA en vez de devolver basura', () => {
    // Es el punto de GCM: sin esto se imprimirían 6 caracteres al azar en una
    // etiqueta como si fueran una password.
    const blob = seal(key, '2B0C49');
    blob[blob.length - 1] ^= 0xff;
    expect(() => open(key, blob)).toThrow();
  });

  it('un authTag alterado también TIRA', () => {
    const blob = seal(key, '2B0C49');
    blob[13] ^= 0xff; // dentro del tag (12..27)
    expect(() => open(key, blob)).toThrow();
  });

  it('otra clave no descifra', () => {
    const otra = loadKey(Buffer.alloc(32, 9).toString('base64'), 'X');
    expect(() => open(otra, seal(key, '2B0C49'))).toThrow();
  });

  it('el layout es iv(12) || tag(16) || ct — el mismo que arma el provisioner', () => {
    // Si esto cambia, hay que cambiar `cifrado.py` en el repo del GtD en el
    // mismo commit, o los dos lados dejan de entenderse.
    const blob = seal(key, 'ABCDEF');
    expect(blob.length).toBe(12 + 16 + 6);
  });
});
