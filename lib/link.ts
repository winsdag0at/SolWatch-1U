// LoRa 433 MHz link budget and airtime for the SX1278 downlink.

import { slantRangeKm } from './orbit';

export interface LinkConfig {
  freqMHz: number;
  txDbm: number;
  satGainDbi: number;
  gsGainDbi: number;
  cableLossDb: number;
  polLossDb: number;
  atmLossDb: number;
  pointingLossDb: number;
  sf: 7 | 8 | 9 | 10 | 11 | 12;
  bwKHz: number;
  requiredMarginDb: number;
  sBytes: number; // on-air size of an S packet (binary-packed)
  nBytes: number; // on-air size of an N packet
  sEveryMin: number; // S sampling interval per farm
  nEveryMin: number; // N sampling interval per farm
}

export const DEFAULT_LINK: LinkConfig = {
  freqMHz: 433,
  txDbm: 20, // SX1278 PA_BOOST maximum
  satGainDbi: 0, // deployable quarter-wave whip on a 1U body
  gsGainDbi: 7, // small 433 MHz Yagi
  cableLossDb: 1.5,
  polLossDb: 3, // linear sat antenna vs. tumbling geometry
  atmLossDb: 1,
  pointingLossDb: 1,
  sf: 11,
  bwKHz: 125,
  requiredMarginDb: 3,
  sBytes: 24,
  nBytes: 14,
  sEveryMin: 10,
  nEveryMin: 15,
};

/** SX1276/77/78 receiver sensitivity at 125 kHz (datasheet table). */
const SENS_125: Record<number, number> = { 7: -123, 8: -126, 9: -129, 10: -132, 11: -134.5, 12: -137 };
/** Demodulator SNR limit per SF (datasheet). */
export const SNR_LIMIT: Record<number, number> = { 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20 };

export function sensitivityDbm(sf: number, bwKHz: number) {
  return SENS_125[sf] + 10 * Math.log10(bwKHz / 125);
}

export const noiseFloorDbm = (bwKHz: number, nfDb = 6) => -174 + 10 * Math.log10(bwKHz * 1000) + nfDb;

export const fsplDb = (km: number, mhz: number) => 20 * Math.log10(km) + 20 * Math.log10(mhz) + 32.44;

/** LoRa time-on-air (Semtech AN1200.13), explicit header, CRC on, CR 4/5, 8-symbol preamble. */
export function airtimeMs(bytes: number, sf: number, bwKHz: number) {
  const tSym = Math.pow(2, sf) / (bwKHz * 1000) * 1000; // ms
  const de = tSym > 16 ? 1 : 0;
  const cr = 1;
  const payloadSym = 8 + Math.max(Math.ceil((8 * bytes - 4 * sf + 28 + 16) / (4 * (sf - 2 * de))) * (cr + 4), 0);
  return (8 + 4.25) * tSym + payloadSym * tSym;
}

export const bitRate = (sf: number, bwKHz: number) => sf * (bwKHz * 1000 / Math.pow(2, sf)) * (4 / 5);

export interface BudgetLine { label: string; value: number; unit: string; note?: string }

export function linkBudget(c: LinkConfig, elDeg: number, altKm: number) {
  const range = slantRangeKm(elDeg, altKm);
  const fspl = fsplDb(range, c.freqMHz);
  const losses = c.cableLossDb + c.polLossDb + c.atmLossDb + c.pointingLossDb;
  const rssi = c.txDbm + c.satGainDbi + c.gsGainDbi - fspl - losses;
  const sens = sensitivityDbm(c.sf, c.bwKHz);
  const margin = rssi - sens;
  const snr = rssi - noiseFloorDbm(c.bwKHz);
  const lines: BudgetLine[] = [
    { label: 'Transmit power (SX1278)', value: c.txDbm, unit: 'dBm' },
    { label: 'Satellite antenna gain', value: c.satGainDbi, unit: 'dBi' },
    { label: `Slant range @ ${elDeg.toFixed(0)}° elevation`, value: range, unit: 'km' },
    { label: 'Free-space path loss', value: -fspl, unit: 'dB' },
    { label: 'Cable + polarization + atmos. + pointing', value: -losses, unit: 'dB' },
    { label: 'Ground antenna gain', value: c.gsGainDbi, unit: 'dBi' },
    { label: 'Received power (RSSI)', value: rssi, unit: 'dBm' },
    { label: `Receiver sensitivity (SF${c.sf}, ${c.bwKHz} kHz)`, value: sens, unit: 'dBm' },
    { label: 'Link margin', value: margin, unit: 'dB', note: margin >= c.requiredMarginDb ? 'OK' : margin >= 0 ? 'thin' : 'link fails' },
  ];
  return { range, fspl, rssi, sens, margin, snr, lines };
}
