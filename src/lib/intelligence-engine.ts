type RawRecord = Record<string, unknown>;

export type Severity = 'CRITICAL' | 'HIGH' | 'ELEVATED' | 'LOW' | 'INFO';

export type FeedStatus = {
  module: string;
  ok: boolean;
  status: 'OK' | 'DEGRADED' | 'OFFLINE';
  latencyMs?: number;
  error?: string;
};

export type OperationalData = {
  earthquakes?: RawRecord[];
  fires?: RawRecord[];
  weather_events?: RawRecord[];
  gdelt?: RawRecord[];
  news?: RawRecord[];
  cyber_threats?: RawRecord[];
  malware_threats?: RawRecord[];
  maritime_chokepoints?: RawRecord[];
  maritime_ports?: RawRecord[];
  maritime_ships?: RawRecord[];
  commercial_flights?: RawRecord[];
  private_flights?: RawRecord[];
  private_jets?: RawRecord[];
  military_flights?: RawRecord[];
  gps_jamming?: RawRecord[];
  satellites?: RawRecord[];
  feed_status?: FeedStatus[];
};

export type IntelligenceFinding = {
  id: string;
  module: string;
  title: string;
  assessment: string;
  severity: Severity;
  importance_score: number;
  risk_score: number;
  confidence_score: number;
  alert_condition: string;
  scoring_formula: string;
  signals: Record<string, number | string | boolean | null>;
  evidence: string[];
  correlations: string[];
  recommended_actions: string[];
  location?: { lat: number; lng: number };
};

export type ModuleIntelligenceSummary = {
  module: string;
  status: 'OK' | 'DEGRADED' | 'OFFLINE';
  missing_insight: string;
  anomaly_detection: string[];
  correlation_logic: string[];
  scoring_formula: string;
  findings: number;
};

export type IntelligenceReport = {
  generated_at: string;
  summary: {
    total_findings: number;
    critical: number;
    high: number;
    elevated: number;
    top_priority: IntelligenceFinding[];
  };
  modules: ModuleIntelligenceSummary[];
  findings: IntelligenceFinding[];
  feed_status: FeedStatus[];
};

const MODULE_DESIGNS: Omit<ModuleIntelligenceSummary, 'status' | 'findings'>[] = [
  {
    module: 'earthquakes',
    missing_insight: 'Impact context: proximity to ports, infrastructure, weather, and news escalation.',
    anomaly_detection: ['M6+ event', 'shallow high-energy event', 'regional seismic clustering', 'tsunami flag'],
    correlation_logic: ['Nearby ports/infrastructure within 250 km', 'nearby weather or conflict/news within 300 km'],
    scoring_formula: 'risk = 10*mag + shallow_bonus + tsunami_bonus + proximity_bonus + cluster_bonus',
  },
  {
    module: 'maritime',
    missing_insight: 'Operational maritime risk: chokepoint congestion, AIS silence, loitering, and port disruption.',
    anomaly_detection: ['CRITICAL/HIGH chokepoint state', 'excess stopped vessels', 'stale AIS feed', 'ship concentration'],
    correlation_logic: ['Ships/ports near news, weather, fires, or earthquakes', 'chokepoint state plus vessel density'],
    scoring_formula: 'risk = chokepoint_base + density_bonus + stale_feed_penalty + correlated_event_bonus',
  },
  {
    module: 'aviation',
    missing_insight: 'Air activity significance: military clustering, GPS degradation, and airspace disruption risk.',
    anomaly_detection: ['Military cluster', 'GPS jamming zone', 'abnormal low NAC position quality'],
    correlation_logic: ['Aviation anomalies near news/conflict/weather/seismic events within 300 km'],
    scoring_formula: 'risk = jamming_bonus + military_density_bonus + correlated_event_bonus',
  },
  {
    module: 'wildfires',
    missing_insight: 'Exposure risk: fire intensity near infrastructure, ports, population corridors, or weather alerts.',
    anomaly_detection: ['High FRP hotspot', 'fire cluster', 'high-confidence detection density'],
    correlation_logic: ['Fires near infrastructure/ports/weather alerts within 75 km'],
    scoring_formula: 'risk = intensity + confidence + cluster_bonus + exposed_asset_bonus',
  },
  {
    module: 'weather',
    missing_insight: 'Disruption risk: severe weather affecting ports, infrastructure, fires, aviation, or maritime traffic.',
    anomaly_detection: ['Extreme/severe weather alert', 'volcano or severe storm event'],
    correlation_logic: ['Weather near ports, fires, earthquakes, aviation/maritime routes'],
    scoring_formula: 'risk = severity_base + exposed_asset_bonus + compound_hazard_bonus',
  },
  {
    module: 'cyber',
    missing_insight: 'Prioritized threat relevance: KEV/CVE urgency, observed malware geography, exposed services.',
    anomaly_detection: ['Recent KEV volume', 'critical vendor/product exposure', 'malware node concentration'],
    correlation_logic: ['Cyber alerts with infrastructure sectors, country risk, Shodan exposure, malware C2 geography'],
    scoring_formula: 'risk = severity + exploitation_signal + malware_activity + exposure_context',
  },
  {
    module: 'news',
    missing_insight: 'Narrative intelligence: high-risk reporting connected to physical/cyber/geospatial events.',
    anomaly_detection: ['High risk keyword score', 'GDELT conflict/unrest cluster', 'rapid article concentration'],
    correlation_logic: ['News/GDELT near earthquakes, fires, ports, aviation and weather events'],
    scoring_formula: 'risk = news_risk_score*8 + geo_corroboration + cross_domain_bonus',
  },
  {
    module: 'satellites',
    missing_insight: 'Collection opportunity: relevant orbital assets near active high-risk events, TLE freshness.',
    anomaly_detection: ['Stale/degraded TLE feed', 'military/recon satellite near active event'],
    correlation_logic: ['Satellite ground track near top critical/high findings within 500 km'],
    scoring_formula: 'risk = mission_relevance + proximity_to_event + tle_confidence',
  },
];

function isRecord(value: unknown): value is RawRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function records(value: unknown): RawRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function num(record: RawRecord, keys: string[], fallback = 0): number {
  for (const key of keys) {
    const value = record[key];
    const parsed = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function str(record: RawRecord, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return fallback;
}

function bool(record: RawRecord, keys: string[]): boolean {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.toLowerCase());
  }
  return false;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function severityFrom(importance: number, risk: number): Severity {
  const score = Math.max(importance, risk);
  if (score >= 85) return 'CRITICAL';
  if (score >= 70) return 'HIGH';
  if (score >= 50) return 'ELEVATED';
  if (score >= 30) return 'LOW';
  return 'INFO';
}

function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const earthRadiusKm = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(h));
}

function point(record: RawRecord): { lat: number; lng: number } | null {
  const lat = num(record, ['lat', 'latitude'], Number.NaN);
  const lng = num(record, ['lng', 'lon', 'longitude'], Number.NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function finding(input: Omit<IntelligenceFinding, 'severity'>): IntelligenceFinding {
  return {
    ...input,
    importance_score: clamp(input.importance_score),
    risk_score: clamp(input.risk_score),
    confidence_score: clamp(input.confidence_score),
    severity: severityFrom(input.importance_score, input.risk_score),
  };
}

function nearestNamed(
  origin: { lat: number; lng: number },
  items: RawRecord[],
  maxKm: number,
  nameKeys = ['name', 'title', 'place']
): string[] {
  return items
    .map(item => {
      const p = point(item);
      if (!p) return null;
      const km = distanceKm(origin, p);
      if (km > maxKm) return null;
      return `${str(item, nameKeys, 'unnamed')} (${Math.round(km)} km)`;
    })
    .filter((value): value is string => Boolean(value))
    .slice(0, 4);
}

function analyzeEarthquakes(data: OperationalData): IntelligenceFinding[] {
  const quakes = records(data.earthquakes);
  const infrastructure = records(data.maritime_ports);
  const weather = records(data.weather_events);
  const news = [...records(data.news), ...records(data.gdelt)];
  const findings: IntelligenceFinding[] = [];

  for (const eq of quakes) {
    const loc = point(eq);
    if (!loc) continue;
    const magnitude = num(eq, ['magnitude', 'mag']);
    const depth = num(eq, ['depth']);
    const tsunami = bool(eq, ['tsunami']);
    const place = str(eq, ['place', 'location'], 'Unknown location');
    const recentCluster = quakes.filter(other => {
      const otherPoint = point(other);
      if (!otherPoint || other === eq) return false;
      return distanceKm(loc, otherPoint) <= 250;
    }).length;
    const nearbyInfrastructure = nearestNamed(loc, infrastructure, 250);
    const nearbyWeather = nearestNamed(loc, weather, 300, ['title', 'type', 'event']);
    const nearbyNews = nearestNamed(loc, news, 300, ['title', 'name']);
    const majorEvent = magnitude >= 5.5;
    const exposedInfrastructure = magnitude >= 4.5 && nearbyInfrastructure.length > 0;
    const clusteredSeismicity = magnitude >= 4.5 && recentCluster >= 3;

    if (!majorEvent && !exposedInfrastructure && !clusteredSeismicity && !tsunami) continue;

    const risk = magnitude * 10
      + (depth > 0 && depth < 35 ? 10 : 0)
      + (tsunami ? 25 : 0)
      + Math.min(15, recentCluster * 3)
      + Math.min(20, nearbyInfrastructure.length * 8)
      + Math.min(10, nearbyWeather.length * 5);

    if (risk < 50) continue;

    findings.push(finding({
      id: `earthquake:${str(eq, ['id'], `${loc.lat},${loc.lng}`)}`,
      module: 'earthquakes',
      title: `Earthquake impact risk near ${place}`,
      assessment: `M${magnitude.toFixed(1)} earthquake detected with ${nearbyInfrastructure.length} nearby infrastructure/port indicators and ${recentCluster} regional seismic neighbor(s).`,
      importance_score: risk + (nearbyNews.length * 4),
      risk_score: risk,
      confidence_score: 75 + (nearbyInfrastructure.length ? 10 : 0) + (tsunami ? 5 : 0),
      alert_condition: 'M6+, tsunami flag, shallow event with nearby infrastructure, or regional seismic cluster.',
      scoring_formula: 'risk = 10*mag + shallow_bonus + tsunami_bonus + proximity_bonus + cluster_bonus',
      signals: { magnitude, depth_km: depth, tsunami, nearby_infrastructure: nearbyInfrastructure.length, cluster_count: recentCluster },
      evidence: [`USGS event: ${place}`, `Magnitude ${magnitude}`, `Depth ${depth} km`],
      correlations: [...nearbyInfrastructure, ...nearbyWeather, ...nearbyNews],
      recommended_actions: ['Check transport nodes and ports within 250 km.', 'Monitor aftershocks and tsunami bulletins.', 'Cross-check regional news for disruption reports.'],
      location: loc,
    }));
  }

  return findings
    .sort((a, b) => Math.max(b.importance_score, b.risk_score) - Math.max(a.importance_score, a.risk_score))
    .slice(0, 12);
}

function analyzeMaritime(data: OperationalData): IntelligenceFinding[] {
  const chokepoints = records(data.maritime_chokepoints);
  const ships = records(data.maritime_ships);
  const news = [...records(data.news), ...records(data.gdelt), ...records(data.weather_events)];
  const findings: IntelligenceFinding[] = [];
  const stoppedShips = ships.filter(ship => num(ship, ['speed', 'sog'], 99) <= 0.5);

  for (const choke of chokepoints) {
    const loc = point(choke);
    if (!loc) continue;
    const riskLabel = str(choke, ['risk'], 'LOW').toUpperCase();
    const nearbyShips = ships.filter(ship => {
      const shipPoint = point(ship);
      return shipPoint ? distanceKm(loc, shipPoint) <= 100 : false;
    });
    const nearbyStopped = stoppedShips.filter(ship => {
      const shipPoint = point(ship);
      return shipPoint ? distanceKm(loc, shipPoint) <= 100 : false;
    });
    const correlations = nearestNamed(loc, news, 250, ['title', 'name', 'type']);
    const base = riskLabel === 'CRITICAL' ? 80 : riskLabel === 'HIGH' ? 65 : riskLabel === 'ELEVATED' ? 50 : 25;
    const risk = base + Math.min(15, nearbyShips.length / 4) + Math.min(15, nearbyStopped.length * 2) + correlations.length * 5;

    if (risk < 55) continue;

    findings.push(finding({
      id: `maritime:${str(choke, ['name'], `${loc.lat},${loc.lng}`)}`,
      module: 'maritime',
      title: `Maritime chokepoint risk: ${str(choke, ['name'], 'Unnamed chokepoint')}`,
      assessment: `${riskLabel} chokepoint state with ${nearbyShips.length} nearby vessel(s) and ${nearbyStopped.length} stopped/loitering indicator(s).`,
      importance_score: risk,
      risk_score: risk,
      confidence_score: 65 + Math.min(20, nearbyShips.length / 3) + (correlations.length ? 10 : 0),
      alert_condition: 'HIGH/CRITICAL chokepoint risk, dense vessel concentration, or stopped vessels near chokepoint.',
      scoring_formula: 'risk = chokepoint_base + density_bonus + stopped_vessel_bonus + correlated_event_bonus',
      signals: { risk_label: riskLabel, nearby_ships: nearbyShips.length, stopped_or_slow_ships: nearbyStopped.length },
      evidence: [str(choke, ['traffic'], 'Traffic data unavailable')],
      correlations,
      recommended_actions: ['Review AIS gaps and vessel destinations.', 'Monitor port dwell/congestion trend.', 'Correlate with weather and security reporting.'],
      location: loc,
    }));
  }

  return findings;
}

function analyzeAviation(data: OperationalData): IntelligenceFinding[] {
  const military = records(data.military_flights);
  const jamming = records(data.gps_jamming);
  const news = [...records(data.news), ...records(data.gdelt), ...records(data.weather_events)];
  const findings: IntelligenceFinding[] = [];

  for (const zone of jamming.slice(0, 5)) {
    const loc = point(zone);
    if (!loc) continue;
    const correlations = nearestNamed(loc, news, 300, ['title', 'name', 'type']);
    const risk = 62 + correlations.length * 8;
    findings.push(finding({
      id: `aviation:gps:${loc.lat}:${loc.lng}`,
      module: 'aviation',
      title: 'GPS degradation zone affecting live aviation tracks',
      assessment: `Low position quality reported in live ADS-B data; ${correlations.length} nearby operational context item(s).`,
      importance_score: risk,
      risk_score: risk,
      confidence_score: 60 + correlations.length * 8,
      alert_condition: 'ADS-B NAC/P degradation zone detected.',
      scoring_formula: 'risk = 62 + correlated_event_bonus',
      signals: { correlated_context: correlations.length },
      evidence: ['ADS-B low navigation accuracy signal'],
      correlations,
      recommended_actions: ['Monitor nearby aircraft route deviations.', 'Compare with NOTAM/weather/conflict reporting.', 'Treat as navigation degradation until corroborated.'],
      location: loc,
    }));
  }

  const seenMilitaryGrids = new Set<string>();
  for (const aircraft of military) {
    const loc = point(aircraft);
    if (!loc) continue;
    const grid = `${Math.round(loc.lat * 2) / 2}:${Math.round(loc.lng * 2) / 2}`;
    if (seenMilitaryGrids.has(grid)) continue;
    seenMilitaryGrids.add(grid);

    const cluster = military.filter(other => {
      const otherPoint = point(other);
      return otherPoint ? distanceKm(loc, otherPoint) <= 150 : false;
    }).length;
    if (cluster < 6) continue;
    const correlations = nearestNamed(loc, news, 300, ['title', 'name', 'type']);
    const risk = 50 + Math.min(30, cluster * 3) + correlations.length * 5;
    findings.push(finding({
      id: `aviation:cluster:${Math.round(loc.lat * 10)}:${Math.round(loc.lng * 10)}`,
      module: 'aviation',
      title: 'Military aviation clustering anomaly',
      assessment: `${cluster} military aircraft clustered within 150 km; ${correlations.length} nearby event correlation(s).`,
      importance_score: risk,
      risk_score: risk - 5,
      confidence_score: 65 + Math.min(20, cluster * 2),
      alert_condition: 'Six or more military aircraft within 150 km.',
      scoring_formula: 'risk = 50 + military_density_bonus + correlated_event_bonus',
      signals: { military_aircraft_cluster: cluster },
      evidence: [`Representative track: ${str(aircraft, ['callsign', 'icao24'], 'unknown')}`],
      correlations,
      recommended_actions: ['Check airspace restrictions and NOTAMs.', 'Track persistence over next 30 minutes.', 'Correlate with regional news and maritime activity.'],
      location: loc,
    }));
  }

  return findings
    .sort((a, b) => Math.max(b.importance_score, b.risk_score) - Math.max(a.importance_score, a.risk_score))
    .slice(0, 12);
}

function analyzeFires(data: OperationalData): IntelligenceFinding[] {
  const fires = records(data.fires);
  const infrastructure = [...records(data.maritime_ports), ...records(data.weather_events)];
  const findings: IntelligenceFinding[] = [];

  for (const fire of fires.slice(0, 300)) {
    const loc = point(fire);
    if (!loc) continue;
    const frp = num(fire, ['frp']);
    const confidence = str(fire, ['confidence'], 'unknown').toLowerCase();
    const cluster = fires.filter(other => {
      const otherPoint = point(other);
      return otherPoint ? distanceKm(loc, otherPoint) <= 75 : false;
    }).length;
    const nearby = nearestNamed(loc, infrastructure, 75, ['name', 'title', 'type']);
    const risk = Math.min(35, frp / 3) + (confidence === 'high' || confidence === 'h' ? 20 : 8) + Math.min(20, cluster * 2) + nearby.length * 10;
    if (risk < 55) continue;
    findings.push(finding({
      id: `fires:${loc.lat}:${loc.lng}:${str(fire, ['date'], '')}`,
      module: 'wildfires',
      title: 'Wildfire exposure risk near operational assets',
      assessment: `Active fire signature with FRP ${Math.round(frp)} and ${nearby.length} nearby asset/weather correlation(s).`,
      importance_score: risk,
      risk_score: risk,
      confidence_score: confidence === 'high' || confidence === 'h' ? 80 : 60,
      alert_condition: 'High FRP, high confidence, dense fire cluster, or proximity to assets.',
      scoring_formula: 'risk = intensity + confidence + cluster_bonus + exposed_asset_bonus',
      signals: { frp, confidence, cluster_count: cluster, nearby_assets: nearby.length },
      evidence: [`FIRMS/EONET detection at ${loc.lat.toFixed(2)},${loc.lng.toFixed(2)}`],
      correlations: nearby,
      recommended_actions: ['Check wind/weather alerts.', 'Identify nearby transport/energy nodes.', 'Monitor FIRMS refresh for expansion.'],
      location: loc,
    }));
  }

  return findings
    .sort((a, b) => Math.max(b.importance_score, b.risk_score) - Math.max(a.importance_score, a.risk_score))
    .slice(0, 12);
}

function analyzeWeather(data: OperationalData): IntelligenceFinding[] {
  const weather = records(data.weather_events);
  const assets = [...records(data.maritime_ports), ...records(data.fires), ...records(data.earthquakes)];
  const findings: IntelligenceFinding[] = [];

  for (const event of weather) {
    const loc = point(event);
    if (!loc) continue;
    const severity = str(event, ['severity'], 'low').toLowerCase();
    const nearby = nearestNamed(loc, assets, 100, ['name', 'title', 'place', 'type']);
    const base = severity === 'high' ? 65 : severity === 'medium' ? 45 : 25;
    const risk = base + nearby.length * 10;
    if (risk < 55) continue;
    findings.push(finding({
      id: `weather:${str(event, ['id', 'title'], `${loc.lat},${loc.lng}`)}`,
      module: 'weather',
      title: `Weather disruption risk: ${str(event, ['title', 'type'], 'Weather alert')}`,
      assessment: `${severity.toUpperCase()} weather event with ${nearby.length} nearby operational correlation(s).`,
      importance_score: risk,
      risk_score: risk,
      confidence_score: 70 + (nearby.length ? 10 : 0),
      alert_condition: 'High/medium weather alert near assets or active hazards.',
      scoring_formula: 'risk = severity_base + exposed_asset_bonus + compound_hazard_bonus',
      signals: { severity, nearby_assets_or_hazards: nearby.length },
      evidence: [str(event, ['source'], 'Weather provider')],
      correlations: nearby,
      recommended_actions: ['Assess affected ports, roads, and aviation routes.', 'Monitor expiration and alert updates.', 'Correlate with wildfire or flood risk.'],
      location: loc,
    }));
  }

  return findings
    .sort((a, b) => Math.max(b.importance_score, b.risk_score) - Math.max(a.importance_score, a.risk_score))
    .slice(0, 10);
}

function analyzeCyber(data: OperationalData): IntelligenceFinding[] {
  const cyber = records(data.cyber_threats);
  const malware = records(data.malware_threats);
  const findings: IntelligenceFinding[] = [];

  const criticalKev = cyber.filter(item => str(item, ['severity'], '').toUpperCase() === 'CRITICAL');
  if (criticalKev.length >= 4) {
    findings.push(finding({
      id: 'cyber:kev-volume',
      module: 'cyber',
      title: 'Elevated exploited-vulnerability pressure',
      assessment: `${criticalKev.length} recent CISA KEV item(s) indicate elevated patch prioritization pressure.`,
      importance_score: 75 + Math.min(15, criticalKev.length),
      risk_score: 70 + Math.min(15, criticalKev.length),
      confidence_score: 85,
      alert_condition: 'Four or more recent CRITICAL KEV items.',
      scoring_formula: 'risk = 70 + recent_kev_volume_bonus',
      signals: { recent_critical_kev: criticalKev.length },
      evidence: criticalKev.slice(0, 5).map(item => `${str(item, ['id'], 'CVE')} ${str(item, ['vendor'], '')}/${str(item, ['product'], '')}`),
      correlations: [],
      recommended_actions: ['Prioritize KEV matching against exposed assets.', 'Enrich affected vendors with Shodan/InternetDB only for owned or authorized scope.', 'Track exploit deadlines.'],
    }));
  }

  const malwareByCountry = new Map<string, number>();
  for (const item of malware) {
    const country = str(item, ['country']);
    if (!country) continue;
    malwareByCountry.set(country, (malwareByCountry.get(country) || 0) + 1);
  }
  for (const [country, count] of malwareByCountry) {
    if (count < 12) continue;
    const risk = 55 + Math.min(35, count);
    findings.push(finding({
      id: `cyber:malware:${country}`,
      module: 'cyber',
      title: `Malware infrastructure concentration: ${country}`,
      assessment: `${count} malware/C2 indicator(s) are mapped to ${country}; treat as a country-level concentration, not precise geolocation.`,
      importance_score: risk,
      risk_score: risk,
      confidence_score: 55,
      alert_condition: 'Twelve or more mapped malware indicators in one country bucket.',
      scoring_formula: 'risk = 55 + malware_country_volume_bonus',
      signals: { country, mapped_indicators: count },
      evidence: [`abuse.ch mapped indicators: ${count}`],
      correlations: [],
      recommended_actions: ['Do not infer exact city-level location.', 'Correlate against owned asset logs and threat intel.', 'Review top malware families in the feed.'],
    }));
  }

  return findings;
}

function analyzeNews(data: OperationalData): IntelligenceFinding[] {
  const news = [...records(data.news), ...records(data.gdelt)];
  const physical = [...records(data.earthquakes), ...records(data.fires), ...records(data.maritime_chokepoints), ...records(data.weather_events)];
  const findings: IntelligenceFinding[] = [];

  for (const item of news) {
    const riskScore = num(item, ['risk_score'], str(item, ['type']) === 'conflict' ? 8 : 0);
    const loc = point(item);
    if (riskScore < 8 && str(item, ['type']) !== 'conflict') continue;
    const correlations = loc ? nearestNamed(loc, physical, 300, ['name', 'title', 'place', 'type']) : [];
    const risk = riskScore * 8 + correlations.length * 7;
    findings.push(finding({
      id: `news:${str(item, ['id', 'url', 'link', 'title'], cryptoSafeId(str(item, ['title'], 'news')))}`,
      module: 'news',
      title: `High-risk OSINT narrative: ${str(item, ['title', 'name'], 'Untitled report').slice(0, 90)}`,
      assessment: `High-risk OSINT item with ${correlations.length} nearby physical/cyber context correlation(s).`,
      importance_score: risk,
      risk_score: risk - 5,
      confidence_score: loc ? 65 + correlations.length * 8 : 45,
      alert_condition: 'Risk score >= 8, conflict GDELT event, or cross-domain geospatial correlation.',
      scoring_formula: 'risk = news_risk_score*8 + geo_corroboration + cross_domain_bonus',
      signals: { news_risk_score: riskScore, correlations: correlations.length, geocoded: Boolean(loc) },
      evidence: [str(item, ['source'], 'OSINT feed'), str(item, ['title', 'name'], 'Untitled')],
      correlations,
      recommended_actions: ['Verify with second source.', 'Check nearby OSIRIS events.', 'Track whether narrative volume increases over next collection cycle.'],
      location: loc || undefined,
    }));
  }

  return findings;
}

function analyzeSatellites(data: OperationalData, priorFindings: IntelligenceFinding[]): IntelligenceFinding[] {
  const satellites = records(data.satellites);
  const highEvents = priorFindings.filter(item => ['CRITICAL', 'HIGH'].includes(item.severity) && item.location);
  const findings: IntelligenceFinding[] = [];

  for (const sat of satellites.slice(0, 500)) {
    const loc = point(sat);
    if (!loc) continue;
    const mission = str(sat, ['mission']).toLowerCase();
    const relevant = ['military', 'recon', 'sar', 'sigint', 'imaging'].some(term => mission.includes(term));
    if (!relevant) continue;
    const near = highEvents.find(event => event.location && distanceKm(loc, event.location) <= 500);
    if (!near) continue;
    findings.push(finding({
      id: `satellite:${str(sat, ['noradId', 'name'], `${loc.lat},${loc.lng}`)}:${near.id}`,
      module: 'satellites',
      title: `Potential collection opportunity: ${str(sat, ['name'], 'satellite')}`,
      assessment: `${str(sat, ['mission'], 'Unknown mission')} satellite ground track is within 500 km of ${near.title}.`,
      importance_score: 62 + near.importance_score / 4,
      risk_score: 35,
      confidence_score: 50,
      alert_condition: 'Mission-relevant public TLE position near CRITICAL/HIGH OSIRIS finding.',
      scoring_formula: 'importance = 62 + correlated_event_importance/4; confidence limited by TLE prediction uncertainty',
      signals: { correlated_event_score: near.importance_score, range_km_lt: 500 },
      evidence: [`Satellite mission: ${str(sat, ['mission'], 'unknown')}`, `Correlated event: ${near.id}`],
      correlations: [near.title],
      recommended_actions: ['Treat as planning cue, not confirmed collection.', 'Check TLE epoch/source freshness.', 'Queue imagery/collection review if mission and licensing allow.'],
      location: loc,
    }));
  }

  return findings;
}

function cryptoSafeId(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return String(Math.abs(hash));
}

function moduleStatus(module: string, feedStatus: FeedStatus[]): 'OK' | 'DEGRADED' | 'OFFLINE' {
  const status = feedStatus.find(item => item.module === module);
  if (!status) return 'OK';
  return status.status;
}

export function generateIntelligenceReport(data: OperationalData, now = new Date()): IntelligenceReport {
  const feedStatus = data.feed_status || [];
  const findings = [
    ...analyzeEarthquakes(data),
    ...analyzeMaritime(data),
    ...analyzeAviation(data),
    ...analyzeFires(data),
    ...analyzeWeather(data),
    ...analyzeCyber(data),
    ...analyzeNews(data),
  ];

  findings.push(...analyzeSatellites(data, findings));

  findings.sort((a, b) =>
    Math.max(b.importance_score, b.risk_score) - Math.max(a.importance_score, a.risk_score)
    || b.confidence_score - a.confidence_score
  );

  const modules = MODULE_DESIGNS.map(design => ({
    ...design,
    status: moduleStatus(design.module, feedStatus),
    findings: findings.filter(item => item.module === design.module).length,
  }));

  return {
    generated_at: now.toISOString(),
    summary: {
      total_findings: findings.length,
      critical: findings.filter(item => item.severity === 'CRITICAL').length,
      high: findings.filter(item => item.severity === 'HIGH').length,
      elevated: findings.filter(item => item.severity === 'ELEVATED').length,
      top_priority: findings.slice(0, 5),
    },
    modules,
    findings,
    feed_status: feedStatus,
  };
}
