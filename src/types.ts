export interface RaceResult {
  Name: string;
  Time: string;
  Gender: string;
  Category: string;
  Club: string;
  'Culross (CP1)': string;
  'Ferrymuir Gate (CP2)': string;
  'Boness (CP3)': string;
  Finish: string;
  Event: 'Individual' | 'Team of 2' | 'Team of 4';
}

export interface ProcessedRaceResult extends RaceResult {
  id: string;
  arrivalCP1: number; // seconds from start
  arrivalCP2: number;
  arrivalCP3: number;
  arrivalFinish: number;
  totalTimeSec: number;
  rankCP1?: number;
  rankCP2?: number;
  rankCP3?: number;
  rankFinish?: number;
}

export interface DashboardStats {
  totalParticipants: number;
  fastestTime: string;
  slowestTime: string;
  uniqueClubs: number;
}
