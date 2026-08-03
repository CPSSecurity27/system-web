import { ALARM_MODES, alarmMode } from './alarm-modes';

describe('alarmMode', () => {
  it('traduce los códigos del hardware', () => {
    expect(alarmMode('cps006')?.label).toBe('Incendio');
    expect(alarmMode('cps007')?.label).toBe('Médica');
    expect(alarmMode('cps999')?.label).toBe('Desactivar');
  });

  /**
   * Son 8 y no 6: en la app, Médica y Desactivar quedaron con el color escrito
   * a mano fuera del tema, así que es fácil olvidarse de que existen.
   */
  it('están los 8 modos del catálogo', () => {
    expect(ALARM_MODES.length).toBe(8);
    expect(ALARM_MODES.map((m) => m.code)).toContain('cps007');
    expect(ALARM_MODES.map((m) => m.code)).toContain('cps999');
  });

  it('sin código no hay modo', () => {
    expect(alarmMode(null)).toBeNull();
    expect(alarmMode(undefined)).toBeNull();
    expect(alarmMode('')).toBeNull();
  });

  // El hardware manda el código; si aparece uno nuevo preferimos verlo crudo en
  // el tablero antes que perder la fila.
  it('un código desconocido se muestra tal cual en vez de romper', () => {
    const desconocido = alarmMode('cps042');
    expect(desconocido?.label).toBe('cps042');
    expect(desconocido?.toneClass).toBe('mode-desconocido');
  });

  it('cada modo declara etiqueta, ícono y tono', () => {
    for (const modo of ALARM_MODES) {
      expect(modo.label.length).toBeGreaterThan(0);
      expect(modo.icon.startsWith('icon-')).toBe(true);
      expect(modo.toneClass.startsWith('mode-')).toBe(true);
    }
  });

  it('no hay códigos repetidos', () => {
    const codigos = ALARM_MODES.map((m) => m.code);
    expect(new Set(codigos).size).toBe(codigos.length);
  });
});
