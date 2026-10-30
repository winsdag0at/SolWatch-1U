export interface FarmInfo {
  id: string;
  name: string;
  short: string;
  lat: number;
  lon: number;
}

// Approximate site coordinates (for the schematic map only).
export const FARMS: FarmInfo[] = [
  { id: 'AlDhafra', name: 'Al Dhafra Solar PV', short: 'Al Dhafra', lat: 24.13, lon: 54.94 },
  { id: 'NoorAbuDhabi', name: 'Noor Abu Dhabi (Sweihan)', short: 'Noor AD', lat: 24.47, lon: 55.33 },
  { id: 'MBRSolarPark', name: 'Mohammed bin Rashid Al Maktoum Solar Park', short: 'MBR Park', lat: 24.76, lon: 55.37 },
];

export const GROUND_STATION = { name: 'Ground station (Abu Dhabi)', lat: 24.43, lon: 54.47 };

export const farmName = (id: string) => FARMS.find((f) => f.id === id)?.name ?? id;
export const farmShort = (id: string) => FARMS.find((f) => f.id === id)?.short ?? id;
