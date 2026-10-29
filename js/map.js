// Loads the vendored Central Park extract (data/central-park.geojson, built
// from OpenStreetMap by scripts/build_central_park.py) and projects it into
// the model's ground plane: feet, origin in the middle of the Great Lawn,
// rotated so the Manhattan street grid runs along the axes (+y is "Manhattan
// north", about 29° east of true north).

const FT_PER_M = 3.28084;

export const MAP_URL = 'data/central-park.geojson?v=6';

export function makeProjection(frame) {
  const [lon0, lat0] = frame.origin;
  const rad = Math.PI / 180;
  const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * lat0 * rad);
  const mPerDegLon = 111412.84 * Math.cos(lat0 * rad);
  const fx = mPerDegLon * FT_PER_M;
  const fy = mPerDegLat * FT_PER_M;
  const c = Math.cos(frame.gridRotationDeg * rad);
  const s = Math.sin(frame.gridRotationDeg * rad);
  return ([lon, lat]) => {
    const e = (lon - lon0) * fx;
    const n = (lat - lat0) * fy;
    return { x: e * c - n * s, y: e * s + n * c };
  };
}

// Groups features by layer, with coordinates in feet. Polygons keep only
// their outer ring, without the repeated closing point.
export function parseMap(geojson) {
  const project = makeProjection(geojson.frame);
  const map = {
    attribution: geojson.attribution,
    park: null, lawns: [], paths: [], water: [], woods: [], grass: [],
    streets: [], transverses: [], buildings: [],
  };
  const layers = {
    lawn: map.lawns, path: map.paths, water: map.water, wood: map.woods, grass: map.grass,
    street: map.streets, transverse: map.transverses, building: map.buildings,
  };
  for (const f of geojson.features) {
    const { layer, ...props } = f.properties;
    const g = f.geometry;
    let points;
    if (g.type === 'Polygon') {
      points = g.coordinates[0].map(project);
      points.pop();
    } else {
      points = g.coordinates.map(project);
    }
    const item = { ...props, points };
    if (layer === 'park') map.park = item;
    else layers[layer]?.push(item);
  }
  return map;
}

export async function loadMap(url = MAP_URL) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load ${url}: ${res.status}`);
  return parseMap(await res.json());
}
