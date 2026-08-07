import { EspImageError, leerDescriptorEsp } from './esp-image';
import {
  canalDeVersion,
  carpetaDeRanura,
  carpetaDeVersion,
  nombreDelBin,
  urlDeCarpeta,
  validarVersion,
} from './firmware-catalog';

/**
 * Arma una imagen ESP32 mínima pero real: header + segmento + descriptor.
 *
 * Los offsets son los de ESP-IDF y están verificados contra el binario del
 * taller (`build/AlarmaESP32V6_05-03-2026.bin`, 2026-08-06), que devuelve
 * `project_name = "AlarmaESP32V6_05-03-2026"` y `version = "f1a0459-dirty"`.
 */
function imagenFalsa(campos: {
  projectName?: string;
  version?: string;
  fecha?: string;
  hora?: string;
  idf?: string;
  magicImagen?: number;
  magicDesc?: number;
}): Buffer {
  const buf = Buffer.alloc(0x20 + 256 + 64);
  buf[0] = campos.magicImagen ?? 0xe9;
  buf.writeUInt32LE(campos.magicDesc ?? 0xabcd5432, 0x20);

  const escribir = (offset: number, texto: string, largo: number) => {
    buf.write(texto.slice(0, largo - 1), 0x20 + offset, 'latin1');
  };
  escribir(16, campos.version ?? 'f1a0459-dirty', 32);
  escribir(48, campos.projectName ?? 'AlarmaESP32V6_05-03-2026', 32);
  escribir(80, campos.hora ?? '02:23:21', 16);
  escribir(96, campos.fecha ?? 'Aug  6 2026', 16);
  escribir(112, campos.idf ?? 'v5.5.3', 32);
  return buf;
}

describe('leerDescriptorEsp', () => {
  it('lee el proyecto, el build y la fecha de una imagen real', () => {
    const desc = leerDescriptorEsp(imagenFalsa({}));

    expect(desc.projectName).toBe('AlarmaESP32V6_05-03-2026');
    expect(desc.idfVersion).toBe('v5.5.3');
    expect(desc.builtAt).toBe('Aug  6 2026 02:23:21');
  });

  it('el `version` del binario es el git describe, NO la versión OTA', () => {
    // Es la razón por la que la versión del catálogo la escribe una persona:
    // el CMakeLists del firmware no define PROJECT_VER.
    expect(leerDescriptorEsp(imagenFalsa({})).buildVersion).toBe(
      'f1a0459-dirty',
    );
  });

  it('rechaza algo que no es una imagen de ESP32', () => {
    const noEsImagen = imagenFalsa({ magicImagen: 0x4d });
    expect(() => leerDescriptorEsp(noEsImagen)).toThrow(EspImageError);
    expect(() => leerDescriptorEsp(noEsImagen)).toThrow(/magic 0xE9/);
  });

  it('rechaza una imagen sin descriptor de aplicación', () => {
    // El caso real: subir el bootloader.bin, que no se actualiza por OTA.
    const sinDesc = imagenFalsa({ magicDesc: 0x00000000 });
    expect(() => leerDescriptorEsp(sinDesc)).toThrow(/descriptor/);
  });

  it('rechaza un archivo demasiado chico', () => {
    expect(() => leerDescriptorEsp(Buffer.alloc(16))).toThrow(/chico/);
  });

  it('corta los textos en el NUL y no arrastra basura', () => {
    const desc = leerDescriptorEsp(imagenFalsa({ projectName: 'corto' }));
    expect(desc.projectName).toBe('corto');
  });
});

describe('validarVersion', () => {
  it.each(['new_0_7_0', 'stable_2_8_1', 'new_255_255_255'])(
    'acepta %s',
    (v) => {
      expect(validarVersion(v)).toHaveLength(0);
    },
  );

  it.each([
    ['0.7.0', 'con puntos en vez de guiones bajos'],
    ['new-0-7-0', 'con guiones medios'],
    ['beta_0_7_0', 'con un canal que el firmware no usa'],
    ['new_0_7', 'sin el tercer número'],
    ['', 'vacía'],
  ])('rechaza "%s" (%s)', (v) => {
    expect(validarVersion(v).length).toBeGreaterThan(0);
  });
});

describe('el canal sale del prefijo', () => {
  it('stable_ es estable y todo lo demás es new', () => {
    expect(canalDeVersion('stable_2_8_1')).toBe('stable');
    expect(canalDeVersion('new_0_7_0')).toBe('new');
  });
});

describe('dónde vive cada cosa', () => {
  it('la carpeta lleva la versión COMPLETA, con el canal adentro', () => {
    // Con el número pelado (`0_7_0/`, como sugiere la nota del firmware),
    // new_0_7_0 y stable_0_7_0 caerían en la misma carpeta.
    expect(carpetaDeVersion('new_0_7_0')).toBe('alarmavecinal/ota/new_0_7_0');
    expect(carpetaDeVersion('stable_0_7_0')).toBe(
      'alarmavecinal/ota/stable_0_7_0',
    );
  });

  it('las dos ranuras son las bases hardcodeadas del firmware', () => {
    expect(carpetaDeRanura('new')).toBe('alarmavecinal/ota/new');
    expect(carpetaDeRanura('emergency')).toBe('alarmavecinal/ota/emergency');
  });

  it('la URL sale del APEX y termina en barra', () => {
    // El host es exacto: `ota_url_is_allowed` compara contra
    // `cpssecurity.com.ar`, así que `system.` se rechazaría.
    expect(urlDeCarpeta(carpetaDeVersion('new_0_7_0'))).toBe(
      'https://cpssecurity.com.ar/firmware/alarmavecinal/ota/new_0_7_0/',
    );
  });

  it('en emergencia el nombre del .bin es fijo', () => {
    // El equipo NO lo arma desde el manifiesto en ese modo: ya sabe que busca
    // emergency.bin.
    expect(nombreDelBin('new_0_7_0')).toBe('new_0_7_0.bin');
    expect(nombreDelBin('new_0_7_0', 'new')).toBe('new_0_7_0.bin');
    expect(nombreDelBin('new_0_7_0', 'emergency')).toBe('emergency.bin');
  });
});
