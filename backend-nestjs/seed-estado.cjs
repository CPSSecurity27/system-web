/**
 * Estado de prueba para poder mirar la ficha con datos.
 *
 * Va por la MISMA función que usa el servicio de alarmas
 * (`gtd.upsert_panel_state`), con el mismo payload que manda el firmware
 * (`AlarmaESP32V6/docs/mqtt_design.md` §5.2). Así lo que se ve en pantalla es la
 * pantalla leyendo la base de verdad, y no valores inventados en el template —
 * que es como se termina mostrando un dato falso como si fuera real.
 *
 * Se borra con: DELETE FROM device_state;
 */
const { Client } = require('pg');
const fs = require('fs');

const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const ENERGIA = { modo: 'ACTIVE_240', vbat: 12.6, vpanel: 13.9, vfuente: 0.0 };
const RED = { ssid: 'MuniWiFi', ip: '192.168.1.7', rssi: -61, recon: 3, ping_fail: 0, wdt: 0 };
const TELE = {
  rtc: { q: 0, sync_hace_s: 120, ds3231: true, ntp_boot: true },
  modulos: { supervisor: false, ds3231_ok: true, eeprom_kb: 32 },
  ota: { estado: 0, ultimo: 0 },
  rf: { rx: 123, dec: 50, rechaz: 1, supr: 4, desc: 2, lim: 0, ee_err: 0, drops: 0 },
  sueno: { despierta: 0, motivo: 0 },
  colas: { admin_drops: 0, mqtt_out_drops: 0 },
};

(async () => {
  const c = new Client({
    host: env.DB_HOST, port: +env.DB_PORT,
    user: env.DB_MIGRATIONS_USER, password: env.DB_MIGRATIONS_PASSWORD,
    database: env.DB_NAME,
  });
  await c.connect();

  const d = await c.query(
    `SELECT mac, serial FROM device WHERE mac IS NOT NULL ORDER BY id LIMIT 1`);
  if (!d.rows[0]) {
    console.log('No hay equipos con MAC: fabricá uno primero.');
    await c.end();
    return;
  }

  const { mac, serial } = d.rows[0];
  await c.query(
    `SELECT gtd.upsert_panel_state(
       p_mac => $1::TEXT, p_estado => 'online', p_modo_energia => $2::TEXT,
       p_alarma_mode => 'off', p_cfg_v => 13::BIGINT, p_rf_gen => 4::BIGINT,
       p_energia => $3::JSONB, p_fw => 'new_0_6_0',
       p_ts_device => $4::BIGINT, p_tsq => 0::SMALLINT,
       p_red => $5::JSONB, p_tele => $6::JSONB)`,
    [mac, ENERGIA.modo, JSON.stringify(ENERGIA), Math.floor(Date.now() / 1000),
      JSON.stringify(RED), JSON.stringify(TELE)]);

  const r = await c.query(
    `SELECT online, ssid, ip, rssi, recon, ping_fail, vbat, vpanel, fw,
            (SELECT string_agg(k, ', ') FROM jsonb_object_keys(tele) k) AS secciones
       FROM device_state WHERE device_id = (SELECT id FROM device WHERE mac = $1)`,
    [mac]);

  console.log('estado cargado para', serial);
  console.table(r.rows);
  await c.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
