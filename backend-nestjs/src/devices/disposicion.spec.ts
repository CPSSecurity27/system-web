import { motivoParaNoDisponer } from './devices.service';

/**
 * LA regla del flujo de instalación: quién puede llevarse qué equipo a dónde.
 *
 * Lo que gobierna no es el código de reclamo —que nunca se quema— sino de quién
 * es el equipo. Es lo que impide que alguien fotografíe la etiqueta de un equipo
 * ajeno y se lo lleve.
 */
const CPS = { esCps: true, organizacionesPropias: [] as number[] };
const MUNI_A = { esCps: false, organizacionesPropias: [7] };
const MUNI_B = { esCps: false, organizacionesPropias: [9] };

describe('equipo SIN dueño (fábrica CPS)', () => {
  it('lo puede reclamar cualquiera: es la primera reclamación', () => {
    // Este es el caso que antes daba 403 y bloqueaba todo el flujo: una muni
    // recibía la caja y no podía ponerla en servicio hasta que CPS hiciera la
    // entrega en el sistema.
    expect(
      motivoParaNoDisponer({
        stockDelEquipo: null,
        duenoDelBarrio: 7,
        ...MUNI_A,
      }),
    ).toBeNull();
  });

  it('también CPS, a cualquier barrio', () => {
    expect(
      motivoParaNoDisponer({ stockDelEquipo: null, duenoDelBarrio: 9, ...CPS }),
    ).toBeNull();
  });

  it('y a un barrio sin organización dueña', () => {
    expect(
      motivoParaNoDisponer({
        stockDelEquipo: null,
        duenoDelBarrio: null,
        ...CPS,
      }),
    ).toBeNull();
  });
});

describe('equipo del stock de una organización', () => {
  it('esa organización lo instala en su barrio', () => {
    expect(
      motivoParaNoDisponer({ stockDelEquipo: 7, duenoDelBarrio: 7, ...MUNI_A }),
    ).toBeNull();
  });

  it('otra organización NO puede tocarlo', () => {
    const motivo = motivoParaNoDisponer({
      stockDelEquipo: 7,
      duenoDelBarrio: 9,
      ...MUNI_B,
    });
    expect(motivo).toMatch(/stock de otra organización/);
  });

  it('CPS SÍ puede usarlo, pero solo para un barrio de ESE cliente', () => {
    expect(
      motivoParaNoDisponer({ stockDelEquipo: 7, duenoDelBarrio: 7, ...CPS }),
    ).toBeNull();
  });

  it('CPS NO puede pasarlo a un barrio de otro cliente', () => {
    // Sería una entrega encubierta: un activo cambia de cliente sin registro
    // comercial. Que CPS pueda todo lo demás no vuelve esto aceptable.
    const motivo = motivoParaNoDisponer({
      stockDelEquipo: 7,
      duenoDelBarrio: 9,
      ...CPS,
    });
    expect(motivo).toMatch(/otro cliente/);
  });

  it('CPS tampoco a un barrio sin dueño', () => {
    expect(
      motivoParaNoDisponer({ stockDelEquipo: 7, duenoDelBarrio: null, ...CPS }),
    ).not.toBeNull();
  });
});

describe('casos de borde', () => {
  it('un usuario de varias organizaciones puede usar el stock de cualquiera de ellas', () => {
    const dosMunis = { esCps: false, organizacionesPropias: [7, 9] };
    expect(
      motivoParaNoDisponer({
        stockDelEquipo: 9,
        duenoDelBarrio: 9,
        ...dosMunis,
      }),
    ).toBeNull();
  });

  it('un usuario sin ninguna organización no puede disponer de stock ajeno', () => {
    const suelto = { esCps: false, organizacionesPropias: [] as number[] };
    expect(
      motivoParaNoDisponer({ stockDelEquipo: 7, duenoDelBarrio: 7, ...suelto }),
    ).not.toBeNull();
  });

  it('para la organización dueña, el barrio destino no cambia la respuesta', () => {
    // El otro eje —a qué barrios llega— lo valida el alcance, no esta regla.
    // Que acá no se mezclen es lo que permite razonar sobre cada uno por
    // separado.
    expect(
      motivoParaNoDisponer({
        stockDelEquipo: 7,
        duenoDelBarrio: 99,
        ...MUNI_A,
      }),
    ).toBeNull();
  });
});
