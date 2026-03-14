export interface CorridorRiskEntry {
  riskLevel: string;
  incidentCount7d: number;
  disruptionPct: number;
}

export interface CorridorRiskData {
  [chokepointId: string]: CorridorRiskEntry;
}
