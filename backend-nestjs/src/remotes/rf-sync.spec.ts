import {
  CLIENTES_POR_LOTE,
  PAYLOAD_MAX_BYTES,
  armarPasos,
  capacidadDeRegistros,
  dniParaElPanel,
  explicarDetalle,
  hashDeCodigos,
  motivoDeSalteo,
} from './rf-sync';

describe('hash de códigos (FNV-1a del firmware)', () => {
  /**
   * Los esperados NO salen de correr esta función: se calcularon aparte
   * transcribiendo `rf_client_hash()` de `task_mqtt.c`. Si el día de mañana el
   * hash de acá deja de coincidir con el del panel, la auditoría compararía dos
   * números que nunca van a ser iguales y todo aparecería como desincronizado.
   */
  it.each([
    [[{ position: 1, codigo: 123456 }], 2350962274],
    [
      [
        { position: 1, codigo: 123456 },
        { position: 2, codigo: 234567 },
        { position: 3, codigo: 345678 },
        { position: 4, codigo: 456789 },
      ],
      4097875174,
    ],
    // 12 dígitos: no entra en un int32, y ahí es donde una implementación
    // ingenua con `>>` en vez de BigInt se rompe en silencio.
    [[{ position: 1, codigo: 999999999999 }], 1959367390],
    [[{ position: 1, codigo: 10000 }], 4227062632],
    [
      [
        { position: 1, codigo: 123456 },
        { position: 2, codigo: 234567 },
      ],
      1033405849,
    ],
    // La POSICIÓN entra en el hash: el mismo código en otro botón da distinto.
    [[{ position: 2, codigo: 234567 }], 2372307172],
  ])('%j -> %i', (codigos, esperado) => {
    expect(hashDeCodigos(codigos)).toBe(esperado);
  });

  it('el orden en que vienen los códigos no cambia el hash', () => {
    const a = hashDeCodigos([
      { position: 1, codigo: 123456 },
      { position: 2, codigo: 234567 },
    ]);
    const b = hashDeCodigos([
      { position: 2, codigo: 234567 },
      { position: 1, codigo: 123456 },
    ]);
    expect(a).toBe(b);
  });

  it('siempre cae en el rango de un uint32', () => {
    const h = hashDeCodigos([{ position: 4, codigo: 999999999999 }]);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(4294967295);
    expect(Number.isInteger(h)).toBe(true);
  });
});

describe('capacidad del chip', () => {
  it('un AT24C32 da 126 vecinos', () => {
    // El panel reporta KILOBYTES (`size_bytes / 1024` en mqtt_payload.c): un
    // AT24C32 son 4096 bytes y manda 4. Leerlo como kilobits daba un techo de
    // 14 y marcaba controles como NO_ENTRA con el chip casi vacío.
    expect(capacidadDeRegistros(4)).toBe(126);
  });

  it('sin telemetría se asume el chip más chico', () => {
    // Equivocarse para abajo hace que sobre lugar; para arriba, que el equipo
    // corte una tanda por la mitad con EE_FULL.
    expect(capacidadDeRegistros(null)).toBe(126);
    expect(capacidadDeRegistros(0)).toBe(126);
  });

  it('un chip grande no pasa del tope del journal', () => {
    // Un AT24C64 (8 KB) ya da 254 páginas útiles, y journal_idx es 1 byte.
    expect(capacidadDeRegistros(8)).toBe(254);
    expect(capacidadDeRegistros(64)).toBe(254);
  });
});

describe('DNI para el panel', () => {
  it('acepta el DNI con puntos: es como se dicta', () => {
    expect(dniParaElPanel('30.111.222')).toBe(30111222);
    expect(dniParaElPanel('30111222')).toBe(30111222);
  });

  it('rechaza lo que el uint32 del equipo no aguanta', () => {
    expect(dniParaElPanel('123456789')).toBeNull(); // 9 dígitos
    expect(dniParaElPanel('0')).toBeNull();
  });

  it('rechaza lo que no es un número', () => {
    expect(dniParaElPanel(null)).toBeNull();
    expect(dniParaElPanel('')).toBeNull();
    expect(dniParaElPanel('CI 12345')).toBeNull();
  });
});

describe('qué control no se puede cargar', () => {
  const ok = {
    dni: '30111222',
    codigos: [
      { position: 1, codigo: 123456 },
      { position: 2, codigo: 234567 },
    ],
  };

  it('uno completo entra', () => {
    expect(motivoDeSalteo(ok)).toBeNull();
  });

  it('sin portador no hay dónde guardarlo: la base es por DNI', () => {
    expect(motivoDeSalteo({ ...ok, dni: null })).toBe('SIN_PORTADOR');
  });

  it('con un DNI que el equipo no puede guardar', () => {
    expect(motivoDeSalteo({ ...ok, dni: '123456789' })).toBe('DNI_INVALIDO');
  });

  it('sin códigos no hay nada que mandar', () => {
    expect(motivoDeSalteo({ ...ok, codigos: [] })).toBe('SIN_CODIGOS');
  });

  /**
   * El caso que más importa: `op:batch` llena code[0], code[1]… en el orden del
   * array. Un control con las posiciones 1 y 3 llegaría con el botón de alerta
   * puesto donde va el de sospechoso. No hay forma de expresar el hueco.
   */
  it('con un hueco de posición se saltea', () => {
    expect(
      motivoDeSalteo({
        ...ok,
        codigos: [
          { position: 1, codigo: 123456 },
          { position: 3, codigo: 345678 },
        ],
      }),
    ).toBe('POSICIONES_CON_HUECO');
  });

  it('con un código fuera del rango del equipo', () => {
    expect(
      motivoDeSalteo({ ...ok, codigos: [{ position: 1, codigo: 999 }] }),
    ).toBe('CODIGO_FUERA_DE_RANGO');
  });
});

describe('el plan', () => {
  const cliente = (id: number) => ({
    remoteId: id,
    dni: 30000000 + id,
    hash: 1000 + id,
    codigos: [123456, 234567],
  });

  it('las bajas van ANTES que las altas', () => {
    // No es orden estético: batch es alta pura y un control que cambió de
    // portador chocaría contra sus propios códigos viejos (EE_DUP).
    const pasos = armarPasos(['30111222'], [cliente(1)]);
    expect(pasos.map((p) => p.op)).toEqual(['del', 'batch']);
  });

  it('las altas se trocean de a 5', () => {
    const altas = Array.from({ length: 12 }, (_, i) => cliente(i + 1));
    const pasos = armarPasos([], altas);

    expect(pasos).toHaveLength(3);
    expect(pasos[0].clientes).toHaveLength(CLIENTES_POR_LOTE);
    expect(pasos[1].clientes).toHaveLength(CLIENTES_POR_LOTE);
    expect(pasos[2].clientes).toHaveLength(2);
  });

  it('cada paso se lleva su meta: sin eso el ack no sabe qué marcar', () => {
    const pasos = armarPasos(['30111222'], [cliente(7)]);

    expect(pasos[0].meta.dnis).toEqual(['30111222']);
    expect(pasos[1].meta.remotes).toEqual([
      { id: 7, dni: '30000007', hash: 1007 },
    ]);
  });

  it('la meta NO viaja adentro de los clientes que se publican', () => {
    const pasos = armarPasos([], [cliente(1)]);
    expect(pasos[0].clientes?.[0]).toEqual({
      dni: 30000001,
      codigos: [123456, 234567],
    });
  });

  it('un lote lleno entra en el payload que acepta el panel', () => {
    // Lo que pasa de MQTT_IN_PAYLOAD_MAX el equipo lo descarta EN SILENCIO:
    // ni ack de error, nada. El peor final posible para un comando.
    const altas = Array.from({ length: CLIENTES_POR_LOTE }, (_, i) => ({
      remoteId: i + 1,
      dni: 99999999,
      hash: 1,
      // Cuatro códigos de 12 dígitos: el lote más pesado que se puede armar.
      codigos: [999999999999, 999999999999, 999999999999, 999999999999],
    }));
    const [paso] = armarPasos([], altas);

    const publicado = JSON.stringify({
      t: 'rf',
      cid: 'cmd-0123456789abcdef01234',
      op: paso.op,
      gen: 4294967295,
      clientes: paso.clientes,
    });
    expect(Buffer.byteLength(publicado)).toBeLessThan(PAYLOAD_MAX_BYTES);
  });
});

describe('el detalle del ack', () => {
  it('traduce el ee_status y deja el original al lado', () => {
    expect(explicarDetalle('ee_status 2 (guardados 3)')).toContain(
      'memoria del equipo está llena',
    );
    expect(explicarDetalle('ee_status 2 (guardados 3)')).toContain(
      'ee_status 2',
    );
  });

  it('lo que no es un ee_status pasa tal cual', () => {
    expect(explicarDetalle('guardados 5')).toBe('guardados 5');
    expect(explicarDetalle(null)).toBeNull();
  });
});
