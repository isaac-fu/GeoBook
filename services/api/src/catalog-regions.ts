// Small central-city boxes: geography is assigned only inside these known areas.
export const catalogRegions = {
  midtown: { city: 'New York', province: 'New York', bbox: [40.740, -74.000, 40.760, -73.970], limit: 60 },
  'san-francisco': { city: 'San Francisco', province: 'California', bbox: [37.775, -122.425, 37.795, -122.395], limit: 20 },
  'los-angeles': { city: 'Los Angeles', province: 'California', bbox: [34.035, -118.275, 34.065, -118.235], limit: 20 },
  'san-diego': { city: 'San Diego', province: 'California', bbox: [32.700, -117.175, 32.730, -117.145], limit: 20 },
  buffalo: { city: 'Buffalo', province: 'New York', bbox: [42.875, -78.895, 42.905, -78.860], limit: 20 },
  albany: { city: 'Albany', province: 'New York', bbox: [42.640, -73.775, 42.670, -73.745], limit: 20 },
} as const;
