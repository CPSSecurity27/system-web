import {
  confirmarActualizacion,
  armarProgreso,
  OTA_ESTADOS,
  OTA_RECHAZOS,
  traducirEstado,
  traducirRechazo,
} from './ota-estados';

/** Un `up t:ota` como el que arma `mqtt_build_up_ota`. */
function progreso(
  estado: number,
  resultado = 0,
  fw: string | null = 'new_0_7_0',
) {
  return {
    estado,
    resultado,
    fw,
    received_at: new Date('2026-08-06T12:00:00Z'),
  };
}

describe('los enums del firmware', () => {
  it('el rollback NO llega por este canal, aunque esté mapeado', () => {
    // `ota_report()` en el firmware emite 8 de los 11 estados. El 7, el 8 y el
    // 9 no los emite NADIE: el self-test que confirma la imagen hace
    // mark_app_valid y no publica ningún up t:ota. O sea que un rollback se ve
    // como "el equipo sigue reportando la versión vieja", no como una falla.
    // El mapeo se mantiene por si el firmware lo emite algún día (F-OTA-5).
    expect(traducirEstado(9)).toBe('volvió a la anterior');
    expect(armarProgreso(progreso(9)).fallo).toBe(true);
  });

  it('tienen exactamente los estados de ota_types.h', () => {
    // Si el firmware suma uno, esto falla y obliga a mirar DÓNDE lo agregó: uno
    // en el medio corre todos los índices siguientes y la tabla mentiría.
    expect(OTA_ESTADOS).toHaveLength(11);
    expect(OTA_RECHAZOS).toHaveLength(9);
  });

  it('traduce los estados por índice', () => {
    expect(traducirEstado(0)).toBe('sin actualizar');
    expect(traducirEstado(4)).toBe('descargando');
    expect(traducirEstado(8)).toBe('confirmada');
    expect(traducirEstado(10)).toBe('falló');
  });

  it('un estado que no conoce dice el número, no inventa', () => {
    // Un "estado desconocido (11)" es una pregunta que alguien puede
    // investigar; un texto equivocado con confianza, no.
    expect(traducirEstado(11)).toBe('estado desconocido (11)');
  });

  it('sin rechazo no hay motivo que mostrar', () => {
    expect(traducirRechazo(0)).toBeNull();
  });

  it('traduce el rechazo en términos de qué pasó, no del nombre del enum', () => {
    expect(traducirRechazo(3)).toMatch(/otro modelo de placa/);
    expect(traducirRechazo(6)).toMatch(/no entra en la memoria/);
    expect(traducirRechazo(7)).toMatch(/se cortó o cambió/);
    expect(traducirRechazo(8)).toMatch(/no es https|no está permitido/);
  });
});

describe('armarProgreso', () => {
  it('marca en curso los pasos en los que el equipo está trabajando', () => {
    for (const estado of [1, 2, 4, 5, 7]) {
      expect(armarProgreso(progreso(estado)).enCurso).toBe(true);
    }
  });

  it('no marca en curso lo que ya terminó', () => {
    for (const estado of [0, 3, 8, 9, 10]) {
      expect(armarProgreso(progreso(estado)).enCurso).toBe(false);
    }
  });

  it('"listo para reiniciar" NO es en curso: es el final del camino', () => {
    // El equipo lo publica y medio segundo después hace esp_restart(). El
    // self-test que confirma la imagen NO publica nada, así que no hay ningún
    // mensaje posterior. Si esto contara como "en curso", la pantalla se
    // repreguntaría para siempre esperando algo que nunca llega.
    const p = armarProgreso(progreso(6));
    expect(p.enCurso).toBe(false);
    expect(p.esperandoReinicio).toBe(true);
    expect(p.fallo).toBe(false);
  });

  it('solo el 6 espera reinicio', () => {
    for (const estado of [0, 1, 2, 3, 4, 5, 7, 8, 9, 10]) {
      expect(armarProgreso(progreso(estado)).esperandoReinicio).toBe(false);
    }
  });

  it('confirmada no es una falla', () => {
    expect(armarProgreso(progreso(8)).fallo).toBe(false);
  });

  it('el manifiesto rechazado es falla y trae el motivo', () => {
    const p = armarProgreso(progreso(3, 3));
    expect(p.fallo).toBe(true);
    expect(p.motivo).toMatch(/otro modelo de placa/);
  });

  it('trae la versión que el equipo declaró (la de ANTES de actualizar)', () => {
    expect(armarProgreso(progreso(8, 0, 'stable_1_0_0')).fw).toBe(
      'stable_1_0_0',
    );
  });
});

/**
 * Confirmar una actualización.
 *
 * El bug que originó todo esto (2026-08-06): la pantalla decía "actualizada"
 * comparando `fw` con la versión publicada. Pero `fw` es la etiqueta de nuestro
 * PROPIO manifiesto que el equipo devuelve —`installed = target`, y `target` lo
 * escribe `task_ota` antes de descargar— y lo único que el self-test comprueba
 * antes de darla por buena es que consiguió internet en 10 minutos.
 */
describe('confirmarActualizacion', () => {
  const listoParaReiniciar = (fwAnterior: string | null, hace = 0) =>
    armarProgreso({
      estado: 6,
      resultado: 0,
      fw: fwAnterior,
      received_at: new Date(Date.now() - hace),
    });

  it('sin progreso no afirma nada', () => {
    expect(
      confirmarActualizacion({
        progreso: null,
        fwActual: 'new_0_7_1',
        ultimaSenal: new Date(),
      }),
    ).toBeNull();
  });

  it('NO confirma con una señal ANTERIOR al reinicio', () => {
    // Lo que sabemos del equipo es de antes de que se reiniciara: no dice nada
    // de cómo le fue.
    const r = confirmarActualizacion({
      progreso: listoParaReiniciar('new_0_7_0', 60_000),
      fwActual: 'new_0_7_1',
      ultimaSenal: new Date(Date.now() - 120_000),
    });
    expect(r?.estado).toBe('reiniciando');
  });

  it('confirma solo si volvió a hablar Y cambió de versión', () => {
    const r = confirmarActualizacion({
      progreso: listoParaReiniciar('new_0_7_0', 120_000),
      fwActual: 'new_0_7_1',
      ultimaSenal: new Date(),
    });
    expect(r?.estado).toBe('arranco');
    // Y ni siquiera ahí se dice "anda bien": se dice lo que se comprobó.
    expect(r?.detalle).toMatch(/no se verifica|internet/i);
  });

  it('volvió con la MISMA versión: revirtió, no es un éxito', () => {
    // Este es el caso que se mostraba en verde.
    const r = confirmarActualizacion({
      progreso: listoParaReiniciar('new_0_7_0', 120_000),
      fwActual: 'new_0_7_0',
      ultimaSenal: new Date(),
    });
    expect(r?.estado).toBe('no_aplico');
    expect(r?.detalle).toMatch(/revirtió/i);
  });

  it('sin saber qué versión tenía antes, no se puede confirmar', () => {
    const r = confirmarActualizacion({
      progreso: listoParaReiniciar(null, 120_000),
      fwActual: 'new_0_7_1',
      ultimaSenal: new Date(),
    });
    expect(r?.estado).toBe('indistinguible');
  });

  it('un fallo del equipo gana sobre cualquier comparación de versiones', () => {
    const r = confirmarActualizacion({
      progreso: armarProgreso({
        estado: 3,
        resultado: 3,
        fw: 'new_0_7_0',
        received_at: new Date(),
      }),
      fwActual: 'new_0_7_1',
      ultimaSenal: new Date(),
    });
    expect(r?.estado).toBe('fallo');
    expect(r?.detalle).toMatch(/otro modelo de placa/);
  });

  it('un equipo que nunca habló no confirma nada', () => {
    const r = confirmarActualizacion({
      progreso: listoParaReiniciar('new_0_7_0'),
      fwActual: null,
      ultimaSenal: null,
    });
    expect(r?.estado).toBe('reiniciando');
  });
});
